<?php
// Proxy voor zKillboard: zKill stuurt geen CORS-headers en eist een nette User-Agent,
// dus we halen het server-side op (korte file-cache). We combineren in één respons de
// recente kills én de top killers — zodat de client maar één (schone) URL hoeft te
// fetchen. Een aparte ?stats=-call werd op sommige machines client-side geblokkeerd
// (ad-blocker/tracking-preventie ziet "stats" als analytics → leeg 204).
require_once 'config.php';
cors();
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-LiteSpeed-Cache-Control: no-cache');

// Character-modus (recruiting-vetting): stats + awox-tellen uit de recente kills.
if (isset($_GET['char'])) {
    $char = (int)$_GET['char'];
    if (!$char) { http_response_code(400); echo json_encode(['error' => 'no char']); exit; }
    $cacheC = sys_get_temp_dir() . "/zkill_char_{$char}.json";
    if (is_file($cacheC) && filesize($cacheC) > 2 && (time() - filemtime($cacheC)) < 600) {
        echo file_get_contents($cacheC); exit;
    }
    $statsRaw = zfetch("https://zkillboard.com/api/stats/characterID/{$char}/");
    $killsRaw = zfetch("https://zkillboard.com/api/kills/characterID/{$char}/");
    $j = $statsRaw ? json_decode($statsRaw, true) : [];
    $awox = 0;
    foreach (($killsRaw ? json_decode($killsRaw, true) : []) as $k) {
        if (!empty($k['zkb']['awox'])) $awox++;
    }
    $out = json_encode([
        'shipsDestroyed' => (int)($j['shipsDestroyed'] ?? 0),
        'shipsLost'      => (int)($j['shipsLost'] ?? 0),
        'dangerRatio'    => (int)($j['dangerRatio'] ?? 0),
        'gangRatio'      => (int)($j['gangRatio'] ?? 0),
        'soloKills'      => (int)($j['soloKills'] ?? 0),
        'awox'           => $awox,
        'hasData'        => $statsRaw ? true : false,
    ]);
    if ($statsRaw) @file_put_contents($cacheC, $out);
    echo $out; exit;
}

$type = preg_match('/^(corporationID|allianceID)$/', $_GET['type'] ?? '') ? $_GET['type'] : 'corporationID';
$id   = (int)($_GET['id'] ?? 0);
if (!$id) { http_response_code(400); echo json_encode(['error' => 'no id']); exit; }

// Feed-modus: gecombineerde recente killmails (kills ÉN losses) van de corp/alliance.
// Geeft de ruwe zKill-lijst terug (killmail_id + zkb); de client verrijkt via ESI.
if (isset($_GET['feed'])) {
    $cacheFeed = sys_get_temp_dir() . "/zkill_feed_{$type}_{$id}.json";
    if (is_file($cacheFeed) && filesize($cacheFeed) > 2 && (time() - filemtime($cacheFeed)) < 120) {
        echo file_get_contents($cacheFeed); exit;
    }
    $raw = zfetch("https://zkillboard.com/api/{$type}/{$id}/");
    if ($raw) { @file_put_contents($cacheFeed, $raw); echo $raw; }
    elseif (is_file($cacheFeed)) { echo file_get_contents($cacheFeed); }
    else { echo '[]'; }
    exit;
}

// Losses-modus: alleen de verloren schepen van de corp/alliance (voor het vijand-dossier).
if (isset($_GET['losses'])) {
    $cacheL = sys_get_temp_dir() . "/zkill_losses_{$type}_{$id}.json";
    if (is_file($cacheL) && filesize($cacheL) > 2 && (time() - filemtime($cacheL)) < 600) {
        echo file_get_contents($cacheL); exit;
    }
    $raw = zfetch("https://zkillboard.com/api/losses/{$type}/{$id}/");
    if ($raw) { @file_put_contents($cacheL, $raw); echo $raw; }
    elseif (is_file($cacheL)) { echo file_get_contents($cacheL); }
    else { echo '[]'; }
    exit;
}

$cacheFile = sys_get_temp_dir() . "/zkill_combo_{$type}_{$id}.json";
// 10 min cache: de feed-aggregatie (killmail-details) is zwaarder, dus minder vaak herrekenen.
if (is_file($cacheFile) && filesize($cacheFile) > 2 && (time() - filemtime($cacheFile)) < 600) {
    echo file_get_contents($cacheFile);
    exit;
}

function zfetch(string $url): ?string {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTPHEADER     => [
            'Accept: application/json',
            'User-Agent: DutchLegionsDashboard/1.0 (j.weijdert@gmail.com)',
        ],
    ]);
    $r = curl_exec($ch);
    $c = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ($c === 200 && $r !== false && $r !== '') ? $r : null;
}

// Veel GET's parallel, in vensters (voorkomt honderden sockets tegelijk).
// Geeft index => body (of null) terug.
function esi_multi(array $urls, int $window = 25): array {
    $out = [];
    $n = count($urls);
    for ($i = 0; $i < $n; $i += $window) {
        $batch = array_slice($urls, $i, $window, true);
        $mh = curl_multi_init();
        $handles = [];
        foreach ($batch as $k => $u) {
            $ch = curl_init($u);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 15,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_HTTPHEADER     => ['Accept: application/json', 'User-Agent: DutchLegionsDashboard/1.0 (j.weijdert@gmail.com)'],
            ]);
            curl_multi_add_handle($mh, $ch);
            $handles[$k] = $ch;
        }
        do { $st = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 1.0); } while ($running > 0 && $st === CURLM_OK);
        foreach ($handles as $k => $ch) {
            $out[$k] = (curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200) ? curl_multi_getcontent($ch) : null;
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
    }
    return $out;
}

$killsRaw = zfetch("https://zkillboard.com/api/kills/{$type}/{$id}/");
$statsRaw = zfetch("https://zkillboard.com/api/stats/{$type}/{$id}/");

$kills = $killsRaw ? json_decode($killsRaw, true) : null;

// Maand-leaderboard uit de ECHTE kill-feed: detail de (max 150 nieuwste) killmails en
// tel per corp/alliance-lid de kills (als aanvaller) van DEZE MAAND. Zo verschijnt
// iederéén met een kill — niet alleen zKill's afgekapte top-10 karakterlijst.
$killers  = [];
$matchKey = ($type === 'allianceID') ? 'alliance_id' : 'corporation_id';
$ymDash   = date('Y-m'); // bv. "2026-07"

$urls = [];
foreach ((is_array($kills) ? array_slice($kills, 0, 150) : []) as $km) {
    $kid  = (int)($km['killmail_id'] ?? 0);
    $hash = (string)($km['zkb']['hash'] ?? '');
    if ($kid && $hash) $urls[] = "https://esi.evetech.net/latest/killmails/{$kid}/{$hash}/?datasource=tranquility";
}

$kc = []; // characterID => kills deze maand
foreach (esi_multi($urls, 25) as $b) {
    if (!$b) continue;
    $km = json_decode($b, true);
    if (!is_array($km) || strpos((string)($km['killmail_time'] ?? ''), $ymDash) !== 0) continue;
    $seen = [];
    foreach (($km['attackers'] ?? []) as $a) {
        $cid = (int)($a['character_id'] ?? 0);
        if ($cid && (int)($a[$matchKey] ?? 0) === $id && empty($seen[$cid])) {
            $seen[$cid] = true;
            $kc[$cid] = ($kc[$cid] ?? 0) + 1;
        }
    }
}

// Per kandidaat (kills>0): naam + maand-losses uit zKill character-stats (parallel).
if ($kc) {
    $ym = date('Ym');
    $statUrls = [];
    foreach (array_keys($kc) as $cid) $statUrls[$cid] = "https://zkillboard.com/api/stats/characterID/{$cid}/";
    $bodies = esi_multi($statUrls, 12);
    foreach ($kc as $cid => $k) {
        $cj   = (isset($bodies[$cid]) && $bodies[$cid]) ? json_decode($bodies[$cid], true) : null;
        $name = is_array($cj) ? (string)($cj['info']['name'] ?? '') : '';
        $loss = is_array($cj) ? (int)($cj['months'][$ym]['shipsLost'] ?? 0) : 0;
        $killers[] = [
            'characterID'   => $cid,
            'characterName' => ($name !== '' ? $name : ('#' . $cid)),
            'kills'         => $k,
            'losses'        => $loss,
        ];
    }
    usort($killers, fn($a, $b) => $b['kills'] <=> $a['kills']);
}

// FALLBACK: leverde de feed niks op (ESI/zKill-storing)? Val terug op zKill's top-10
// karakterlijst zodat de killboard nooit leeg is.
if (!$killers && $statsRaw) {
    $j = json_decode($statsRaw, true);
    foreach (($j['topLists'] ?? []) as $tl) {
        if (($tl['type'] ?? '') === 'character') {
            foreach (array_slice($tl['values'] ?? [], 0, 10) as $v) {
                $killers[] = [
                    'characterID'   => (int)($v['characterID'] ?? 0),
                    'characterName' => (string)($v['characterName'] ?? ''),
                    'kills'         => (int)($v['kills'] ?? 0),
                    'losses'        => 0,
                ];
            }
            break;
        }
    }
}

// Maand-snapshot wegschrijven: bij elke verse load bewaren we de huidige-maand-top-10
// (server-side berekend, dus niet te vervalsen). Zodra de maand voorbij is komen er geen
// updates meer met dat YYYYMM binnen → de snapshot bevriest en wordt het maand-archief.
// Best-effort: een DB-storing mag de killboard nooit breken.
if ($killers) {
    try {
        $pdo = getDB();
        $pdo->exec("CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
            corp_id BIGINT NOT NULL, ym VARCHAR(6) NOT NULL,
            data MEDIUMTEXT, updated_at DATETIME,
            PRIMARY KEY (corp_id, ym))");
        $top = array_slice($killers, 0, 50);
        $st = $pdo->prepare("INSERT INTO leaderboard_snapshots (corp_id, ym, data, updated_at)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()");
        $st->execute([$id, date('Ym'), json_encode($top)]);
    } catch (Exception $e) { /* archief is best-effort */ }
}

// Bij volledige zKill-storing terugvallen op (verlopen) cache.
if ($kills === null && !$killers && is_file($cacheFile) && filesize($cacheFile) > 2) {
    echo file_get_contents($cacheFile);
    exit;
}

$out = json_encode([
    'kills'      => is_array($kills) ? $kills : [],
    'topKillers' => $killers,
]);
@file_put_contents($cacheFile, $out);
echo $out;
