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
if (is_file($cacheFile) && filesize($cacheFile) > 2 && (time() - filemtime($cacheFile)) < 300) {
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

$killsRaw = zfetch("https://zkillboard.com/api/kills/{$type}/{$id}/");
$statsRaw = zfetch("https://zkillboard.com/api/stats/{$type}/{$id}/");

$kills = $killsRaw ? json_decode($killsRaw, true) : null;

$killers = [];
if ($statsRaw) {
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

// Per-pilot losses: haal voor elke top-killer z'n eigen character-stats op (parallel,
// curl_multi) en pak shipsLost. zKill-stats per corp bevat geen per-pilot losses.
if ($killers) {
    $mh = curl_multi_init();
    $handles = [];
    foreach ($killers as $i => $k) {
        $ch = curl_init("https://zkillboard.com/api/stats/characterID/{$k['characterID']}/");
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 12,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HTTPHEADER     => [
                'Accept: application/json',
                'User-Agent: DutchLegionsDashboard/1.0 (j.weijdert@gmail.com)',
            ],
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$i] = $ch;
    }
    do { $st = curl_multi_exec($mh, $running); if ($running) curl_multi_select($mh, 1.0); } while ($running > 0 && $st === CURLM_OK);
    $ym = date('Ym');   // huidige maand, bv. "202606"
    foreach ($handles as $i => $ch) {
        if (curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200) {
            $cj = json_decode(curl_multi_getcontent($ch), true);
            if (is_array($cj)) {
                // kills én losses van DEZE maand (consistente periode)
                $mo = $cj['months'][$ym] ?? null;
                $killers[$i]['kills']  = (int)($mo['shipsDestroyed'] ?? 0);
                $killers[$i]['losses'] = (int)($mo['shipsLost'] ?? 0);
            }
        }
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    // Her-sorteren op de kills van deze maand (de corp-topList was een ander venster).
    usort($killers, fn($a, $b) => $b['kills'] <=> $a['kills']);
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
