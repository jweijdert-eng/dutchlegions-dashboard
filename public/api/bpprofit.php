<?php
/**
 * Bouwwinst-scanner: welke blueprints zijn winstgevend om te bouwen en op Jita
 * te verkopen?  Rekent ALLE manufacturing-recepten door (SDE-bundel
 * /blueprints.json) tegen Jita-prijzen (Fuzzwork) + job-kosten (CCP adjusted
 * prices), en geeft de winstgevende bovenaan.
 *
 *   GET ?action=list[&me=0..10][&refresh=1]
 *
 * Zwaar (duizenden prijzen), dus per ME-waarde 1 uur gecached.
 */

require_once 'config.php';
cors();

const BP_TTL       = 3600;          // scan 1 uur cachen
const BP_REGION    = 10000002;      // Jita / The Forge
const BP_SELL_FEE  = 0.036;         // broker + sales tax bij verkoop (benadering)
const BP_JOB_INDEX = 0.04;          // benaderde system cost index
const BP_SCC       = 0.04;          // SCC-surcharge (4% van EIV)
const BP_TOP       = 400;           // zoveel winstgevende teruggeven
const ESI          = 'https://esi.evetech.net/latest';
const UA           = 'dutchlegions-dashboard (bpprofit)';

// ---------------------------------------------------------------- schema/cache
function bpSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_cache (
        k VARCHAR(64) PRIMARY KEY, v LONGTEXT NOT NULL, updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_namen (
        id BIGINT PRIMARY KEY, naam VARCHAR(255) NOT NULL DEFAULT '', updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}
function bpCacheGet(PDO $pdo, string $key, int $maxAge): ?array {
    $st = $pdo->prepare('SELECT v, UNIX_TIMESTAMP(updated_at) AS ts FROM cc_cache WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    if ($maxAge > 0 && (time() - (int)$row['ts']) > $maxAge) return null;
    $d = json_decode($row['v'], true);
    return is_array($d) ? $d : null;
}
function bpCacheSet(PDO $pdo, string $key, array $value): void {
    $st = $pdo->prepare('INSERT INTO cc_cache (k, v, updated_at) VALUES (?, ?, NOW())
                         ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = NOW()');
    $st->execute([$key, json_encode($value)]);
}

// ---------------------------------------------------------------- http
function bpGet(string $url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
                            CURLOPT_HTTPHEADER => ['User-Agent: ' . UA]]);
    $body = curl_exec($ch);
    $ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
    curl_close($ch);
    return ($ok && $body) ? (json_decode($body, true) ?: null) : null;
}
/** Meerdere GETs parallel. [key=>url] → [key=>decoded|null]. */
function bpMulti(array $urls): array {
    if (!$urls) return [];
    $mh = curl_multi_init(); $h = [];
    foreach ($urls as $k => $u) {
        $ch = curl_init($u);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
                                CURLOPT_HTTPHEADER => ['User-Agent: ' . UA]]);
        curl_multi_add_handle($mh, $ch); $h[$k] = $ch;
    }
    do { $s = curl_multi_exec($mh, $run); if ($run) curl_multi_select($mh, 3); } while ($run && $s === CURLM_OK);
    $out = [];
    foreach ($h as $k => $ch) {
        $body = curl_multi_getcontent($ch);
        $ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
        $out[$k] = ($ok && $body) ? (json_decode($body, true) ?: null) : null;
        curl_multi_remove_handle($mh, $ch); curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

/** Jita-prijzen (Fuzzwork region-aggregates), parallel in brokken. */
function bpPrices(array $typeIds): array {
    $typeIds = array_values(array_unique(array_map('intval', $typeIds)));
    $urls = [];
    foreach (array_chunk($typeIds, 200) as $i => $chunk) {
        $urls[$i] = 'https://market.fuzzwork.co.uk/aggregates/?region=' . BP_REGION
                    . '&types=' . implode(',', $chunk);
    }
    $prices = [];
    foreach (bpMulti($urls) as $data) {
        if (!is_array($data)) continue;
        foreach ($data as $tid => $agg) {
            $prices[(int)$tid] = [
                'sell' => (float)($agg['sell']['min'] ?? 0),
                'buy'  => (float)($agg['buy']['max'] ?? 0),
                'vol'  => (float)($agg['sell']['volume'] ?? 0),
            ];
        }
    }
    return $prices;
}

/** CCP adjusted_price per type (basis voor job-kosten/EIV). */
function bpAdjusted(): array {
    $rows = bpGet(ESI . '/markets/prices/?datasource=tranquility') ?: [];
    $out = [];
    foreach ($rows as $r) if (isset($r['type_id'], $r['adjusted_price'])) $out[(int)$r['type_id']] = (float)$r['adjusted_price'];
    return $out;
}

/** id → naam (types) via bulk /universe/names, gecached. */
function bpNamen(PDO $pdo, array $ids): array {
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
    if ($todo) {
        $ins = $pdo->prepare('INSERT INTO cc_namen (id, naam, updated_at) VALUES (?, ?, NOW())
                              ON DUPLICATE KEY UPDATE naam = VALUES(naam), updated_at = NOW()');
        foreach (array_chunk($todo, 500) as $chunk) {
            $ch = curl_init(ESI . '/universe/names/?datasource=tranquility');
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode(array_values($chunk)),
                CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'User-Agent: ' . UA]]);
            $body = curl_exec($ch);
            $ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
            curl_close($ch);
            if (!$ok) continue;
            foreach ((json_decode($body, true) ?: []) as $r) {
                if (isset($r['id'], $r['name'])) { $uit[(int)$r['id']] = $r['name']; $ins->execute([(int)$r['id'], $r['name']]); }
            }
        }
    }
    return $uit;
}

// ---------------------------------------------------------------- scan
function bpScan(PDO $pdo, int $me, bool $force): array {
    $key = "bp_scan_me{$me}";
    if (!$force) { $c = bpCacheGet($pdo, $key, BP_TTL); if ($c) return $c; }

    $raw = @file_get_contents(__DIR__ . '/../blueprints.json');
    $bps = $raw ? json_decode($raw, true) : null;
    if (!is_array($bps)) return ['ok' => false, 'error' => 'blueprints.json ontbreekt', 'rows' => []];

    // Alle type-ids (blueprint-BPO's + producten + materialen) voor de prijs-lookup.
    $ids = [];
    foreach ($bps as $bpid => $bp) {
        $ids[] = (int)$bpid;                            // de BPO zelf (om te checken of 'ie koopbaar is)
        if (isset($bp['p'][0])) $ids[] = $bp['p'][0];
        foreach (($bp['m'] ?? []) as $m) $ids[] = $m[0];
    }
    $prices = bpPrices($ids);
    $adj = bpAdjusted();

    $rows = [];
    foreach ($bps as $bpid => $bp) {
        // Alleen blueprints waarvan je de BPO daadwerkelijk op de markt kunt kopen.
        // Dat sluit event-/faction-recepten uit én T2 (die via invention gaan) —
        // wat de winst anders sterk zou overschatten.
        if (($prices[(int)$bpid]['sell'] ?? 0) <= 0) continue;

        $pid = (int)($bp['p'][0] ?? 0);
        $outq = (int)($bp['p'][1] ?? 1);
        if (!$pid) continue;
        $psell = $prices[$pid]['sell'] ?? 0;
        if ($psell <= 0) continue;                      // niet (goed) verkoopbaar

        $matcost = 0.0; $eiv = 0.0; $missing = false;
        foreach (($bp['m'] ?? []) as $m) {
            $mat = (int)$m[0]; $qty = (int)$m[1];
            $mp = $prices[$mat]['sell'] ?? 0;
            if ($mp <= 0) { $missing = true; }
            $qme = max(1, (int)ceil($qty * (1 - $me / 100)));
            $matcost += $qme * $mp;
            $eiv += $qty * ($adj[$mat] ?? 0);
        }
        if ($matcost <= 0 || $missing) continue;        // recept met onbekende materiaalprijs → overslaan

        $jobfee = $eiv * (BP_JOB_INDEX + BP_SCC);
        $sellval = $psell * $outq * (1 - BP_SELL_FEE);
        $profit = $sellval - $matcost - $jobfee;
        if ($profit <= 0) continue;

        $kost = $matcost + $jobfee;
        $rows[] = [
            'product_id'  => $pid,
            'output'      => $outq,
            'matcost'     => round($matcost),
            'jobfee'      => round($jobfee),
            'sellval'     => round($sellval),
            'profit'      => round($profit),
            'per_unit'    => round($profit / max(1, $outq)),
            'margin'      => round($profit / $kost * 100, 1),
            'sell'        => round($psell),
            'volume'      => round($prices[$pid]['vol'] ?? 0),
        ];
    }

    usort($rows, fn($a, $b) => $b['margin'] <=> $a['margin']);
    $rows = array_slice($rows, 0, BP_TOP);

    $namen = bpNamen($pdo, array_column($rows, 'product_id'));
    foreach ($rows as &$r) { $r['product'] = $namen[$r['product_id']] ?? ('#' . $r['product_id']); }
    unset($r);

    $out = [
        'ok'         => true,
        'me'         => $me,
        'aantal'     => count($rows),
        'bijgewerkt' => gmdate('c'),
        'rows'       => $rows,
    ];
    bpCacheSet($pdo, $key, $out);
    return $out;
}

// ---------------------------------------------------------------- route
$pdo = getDB();
bpSchema($pdo);
$me = isset($_GET['me']) ? max(0, min(10, (int)$_GET['me'])) : 10;
echo json_encode(bpScan($pdo, $me, !empty($_GET['refresh'])));
