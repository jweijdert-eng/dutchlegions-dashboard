<?php
/**
 * Sovereignty Structures Timer voor één regio (default Cobalt Edge).
 *
 * Publieke ESI, geen token:
 *   /sovereignty/structures/  → elke IHUB/TCU met eigenaar, ADM, kwetsbaarheidsvenster
 *   /sovereignty/campaigns/   → actieve aanvallen met verdediger/aanvaller-scores
 *   /universe/regions|constellations|systems  → de systemen van de regio + namen/security
 *
 * De regio→systemen-kaart is statisch en wordt 30 dagen gecached; de sov-status 5 min.
 *
 *   GET ?action=list[&region=<id>][&refresh=1]
 */

require_once 'config.php';
cors();

const SOV_DEFAULT_REGION = 10000053;   // Cobalt Edge
const SOV_HOME_ALLIANCE  = 99013537;   // Insidious. — "wij"
const SOV_TTL            = 300;        // sov-status 5 min
const SOV_STATIC_TTL     = 2592000;   // regio-kaart + namen 30 dagen
const SOV_TYPES          = [32458 => 'IHUB', 32226 => 'TCU'];
const SOV_TYPES_FULL     = [32458 => 'Infrastructure Hub', 32226 => 'Territorial Claim Unit'];
const ESI                = 'https://esi.evetech.net/latest';

// ---------------------------------------------------------------- schema
function sovSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_cache (
        k VARCHAR(64) PRIMARY KEY, v LONGTEXT NOT NULL, updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_namen (
        id BIGINT PRIMARY KEY, naam VARCHAR(255) NOT NULL DEFAULT '', updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}

function cacheGet(PDO $pdo, string $key, int $maxAge): ?array {
    $st = $pdo->prepare('SELECT v, UNIX_TIMESTAMP(updated_at) AS ts FROM cc_cache WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    if ($maxAge > 0 && (time() - (int)$row['ts']) > $maxAge) return null;
    $d = json_decode($row['v'], true);
    return is_array($d) ? $d : null;
}

function cacheSet(PDO $pdo, string $key, array $value): void {
    $st = $pdo->prepare('INSERT INTO cc_cache (k, v, updated_at) VALUES (?, ?, NOW())
                         ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = NOW()');
    $st->execute([$key, json_encode($value)]);
}

// ---------------------------------------------------------------- http
function esiGet(string $url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
        CURLOPT_HTTPHEADER => ['User-Agent: dutchlegions-dashboard (sovereignty-timer)'],
    ]);
    $body = curl_exec($ch);
    $ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
    curl_close($ch);
    if (!$ok || $body === false) return null;
    $d = json_decode($body, true);
    return is_array($d) ? $d : null;
}

/** Meerdere ESI-GETs parallel. [key => url] → [key => decoded|null]. */
function esiMulti(array $urls): array {
    if (!$urls) return [];
    $mh = curl_multi_init();
    $handles = [];
    foreach ($urls as $key => $url) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => ['User-Agent: dutchlegions-dashboard (sovereignty-timer)'],
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$key] = $ch;
    }
    do { $status = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 2); }
    while ($running && $status === CURLM_OK);

    $out = [];
    foreach ($handles as $key => $ch) {
        $body = curl_multi_getcontent($ch);
        $ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
        $out[$key] = ($ok && $body) ? (json_decode($body, true) ?: null) : null;
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

/** {id: naam} voor characters/corps/allianties (bulk /universe/names, gecached). */
function sovNamen(PDO $pdo, array $ids): array {
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) return [];
    $uit = [];
    foreach (array_chunk($ids, 500) as $chunk) {
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT id, naam FROM cc_namen WHERE id IN ($in)");
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $uit[(int)$r['id']] = $r['naam'];
    }
    $todo = array_values(array_filter($ids, fn($i) => !isset($uit[$i])));
    if (!$todo) return $uit;
    $ins = $pdo->prepare('INSERT INTO cc_namen (id, naam, updated_at) VALUES (?, ?, NOW())
                          ON DUPLICATE KEY UPDATE naam = VALUES(naam), updated_at = NOW()');
    foreach (array_chunk($todo, 500) as $chunk) {
        $ch = curl_init(ESI . '/universe/names/?datasource=tranquility');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode(array_values($chunk)),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'User-Agent: dutchlegions-dashboard (sovereignty-timer)'],
        ]);
        $body = curl_exec($ch);
        $ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
        curl_close($ch);
        if (!$ok) continue;
        foreach ((json_decode($body, true) ?: []) as $r) {
            if (isset($r['id'], $r['name'])) { $uit[(int)$r['id']] = $r['name']; $ins->execute([(int)$r['id'], $r['name']]); }
        }
    }
    return $uit;
}

// ---------------------------------------------------------------- regio-kaart
function regionMap(PDO $pdo, int $region): array {
    $key = 'sov_regionmap_' . $region;
    $c = cacheGet($pdo, $key, SOV_STATIC_TTL);
    if ($c) return $c;

    $reg = esiGet(ESI . "/universe/regions/{$region}/?datasource=tranquility");
    if (!is_array($reg)) return ['name' => "#{$region}", 'systems' => []];

    $conUrls = [];
    foreach (($reg['constellations'] ?? []) as $cid) {
        $conUrls[$cid] = ESI . "/universe/constellations/{$cid}/?datasource=tranquility";
    }
    $cons = esiMulti($conUrls);
    $sysUrls = [];
    foreach ($cons as $c2) {
        if (is_array($c2)) foreach (($c2['systems'] ?? []) as $sid) {
            $sysUrls[$sid] = ESI . "/universe/systems/{$sid}/?datasource=tranquility";
        }
    }
    $syss = esiMulti($sysUrls);
    $systems = [];
    foreach ($syss as $sid => $d) {
        if (is_array($d)) $systems[(int)$sid] = [
            'name' => $d['name'] ?? "#{$sid}",
            'sec'  => round((float)($d['security_status'] ?? 0), 1),
        ];
    }
    $out = ['name' => $reg['name'] ?? "#{$region}", 'systems' => $systems];
    cacheSet($pdo, $key, $out);
    return $out;
}

// ---------------------------------------------------------------- timers
function sovTimers(PDO $pdo, int $region, bool $force): array {
    $key = 'sov_timers_' . $region;
    if (!$force) { $c = cacheGet($pdo, $key, SOV_TTL); if ($c) return $c; }

    $rmap = regionMap($pdo, $region);
    $sysset = $rmap['systems'];
    $now = time();

    $structures = esiGet(ESI . '/sovereignty/structures/?datasource=tranquility') ?: [];
    $campaigns  = esiGet(ESI . '/sovereignty/campaigns/?datasource=tranquility') ?: [];

    $campByStruct = [];
    foreach ($campaigns as $c) {
        if (isset($sysset[$c['solar_system_id'] ?? 0]) && !empty($c['structure_id'])) {
            $campByStruct[$c['structure_id']] = $c;
        }
    }

    $mine = array_values(array_filter($structures, fn($s) => isset($sysset[$s['solar_system_id'] ?? 0])));

    $allyIds = [];
    foreach ($mine as $s) if (!empty($s['alliance_id'])) $allyIds[] = $s['alliance_id'];
    foreach ($campByStruct as $c) if (!empty($c['defender_id'])) $allyIds[] = $c['defender_id'];
    $names = sovNamen($pdo, $allyIds);

    $rows = [];
    foreach ($mine as $s) {
        $sid = (int)($s['solar_system_id'] ?? 0);
        $sys = $sysset[$sid] ?? ['name' => "#{$sid}", 'sec' => 0];
        $start = !empty($s['vulnerable_start_time']) ? strtotime($s['vulnerable_start_time']) : null;
        $end   = !empty($s['vulnerable_end_time'])   ? strtotime($s['vulnerable_end_time'])   : null;
        // Venster voorbij → toon het eerstvolgende (zelfde tijd, +dagen).
        while ($end && $end < $now) { if ($start) $start += 86400; $end += 86400; }

        $camp = $campByStruct[$s['structure_id'] ?? 0] ?? null;
        if ($camp) {
            $status = 'campaign';
            $when = !empty($camp['start_time']) ? strtotime($camp['start_time']) : $start;
        } elseif ($start && $end && $start <= $now && $now <= $end) {
            $status = 'vulnerable'; $when = $end;
        } else {
            $status = 'upcoming'; $when = $start;
        }

        $tid = (int)($s['structure_type_id'] ?? 0);
        $rows[] = [
            'structure_id' => $s['structure_id'] ?? null,
            'system_id'   => $sid,
            'type'        => SOV_TYPES[$tid] ?? (string)$tid,
            'type_full'   => SOV_TYPES_FULL[$tid] ?? (string)$tid,
            'system'      => $sys['name'],
            'sec'         => $sys['sec'],
            'alliance_id' => $s['alliance_id'] ?? null,
            'alliance'    => $names[$s['alliance_id'] ?? 0] ?? '—',
            'ours'        => ((int)($s['alliance_id'] ?? 0) === SOV_HOME_ALLIANCE),
            'adm'         => $s['vulnerability_occupancy_level'] ?? null,
            'status'      => $status,
            'when'        => $when ? gmdate('c', $when) : null,
            'campaign'    => (bool)$camp,
            'defender'    => $camp ? ($names[$camp['defender_id'] ?? 0] ?? '—') : '',
            'defender_score'  => $camp ? (int)round(($camp['defender_score'] ?? 0) * 100) : null,
            'attackers_score' => $camp ? (int)round(($camp['attackers_score'] ?? 0) * 100) : null,
            // Score-beweging (proxy voor "iemand linkt de node") — hieronder gevuld.
            'moved' => false, 'd_def' => 0, 'd_att' => 0, 'trend' => '',
        ];
    }

    // Sorteren: aanval → kwetsbaar → upcoming, elk op eerstvolgend moment.
    $rank = ['campaign' => 0, 'vulnerable' => 1, 'upcoming' => 2];
    usort($rows, function ($a, $b) use ($rank) {
        $ra = $rank[$a['status']] ?? 3; $rb = $rank[$b['status']] ?? 3;
        if ($ra !== $rb) return $ra - $rb;
        return strcmp($a['when'] ?? '9', $b['when'] ?? '9');
    });

    sovScoreBeweging($pdo, $region, $rows, $now);

    $out = [
        'ok'          => true,
        'region'      => $rmap['name'],
        'region_id'   => $region,
        'rows'        => $rows,
        'aantal'      => count($rows),
        'kwetsbaar_nu'=> count(array_filter($rows, fn($r) => in_array($r['status'], ['vulnerable', 'campaign']))),
        'onder_aanval'=> count(array_filter($rows, fn($r) => $r['status'] === 'campaign')),
        'ours_count'  => count(array_filter($rows, fn($r) => $r['ours'])),
        'ours_attack' => count(array_filter($rows, fn($r) => $r['ours'] && $r['status'] === 'campaign')),
        'home'        => SOV_HOME_ALLIANCE,
        'bijgewerkt'  => gmdate('c'),
    ];
    cacheSet($pdo, $key, $out);
    return $out;
}

/** Score-beweging: vergelijk campaign-scores met de vorige snapshot (proxy voor
 *  "iemand linkt de node"). Vult per rij moved/d_def/d_att/trend. */
function sovScoreBeweging(PDO $pdo, int $region, array &$rows, int $now): void {
    $key = 'sov_scores_' . $region;
    $prev = cacheGet($pdo, $key, 0) ?: [];   // maxAge 0 → altijd lezen
    $snap = [];
    foreach ($rows as &$r) {
        if ($r['status'] !== 'campaign') continue;
        $sid = (string)$r['structure_id'];
        $p = $prev[$sid] ?? null;
        if ($p) {
            $r['d_def'] = $r['defender_score'] - (int)$p['def'];
            $r['d_att'] = $r['attackers_score'] - (int)$p['att'];
            $r['moved'] = ($r['d_def'] !== 0 || $r['d_att'] !== 0);
            $r['trend'] = $r['d_att'] > 0 ? 'att' : ($r['d_def'] > 0 ? 'def' : '');
        }
        // Basislijn ~30 min vasthouden zodat de ⚡ lang zichtbaar blijft.
        if ($p && ($now - (int)($p['ts'] ?? 0)) < 1800) $snap[$sid] = $p;
        else $snap[$sid] = ['def' => $r['defender_score'], 'att' => $r['attackers_score'], 'ts' => $now];
    }
    unset($r);
    cacheSet($pdo, $key, $snap);
}

// ---------------------------------------------------------------- route
$pdo = getDB();
sovSchema($pdo);
$region = isset($_GET['region']) ? (int)$_GET['region'] : SOV_DEFAULT_REGION;
echo json_encode(sovTimers($pdo, $region, !empty($_GET['refresh'])));
