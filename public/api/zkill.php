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

$type = preg_match('/^(corporationID|allianceID)$/', $_GET['type'] ?? '') ? $_GET['type'] : 'corporationID';
$id   = (int)($_GET['id'] ?? 0);
if (!$id) { http_response_code(400); echo json_encode(['error' => 'no id']); exit; }

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
                ];
            }
            break;
        }
    }
}

// Bij volledige zKill-storing terugvallen op (verlopen) cache.
if ($kills === null && !$killers && is_file($cacheFile) && filesize($cacheFile) > 2) {
    echo file_get_contents($cacheFile);
    exit;
}

$out = json_encode(['kills' => is_array($kills) ? $kills : [], 'topKillers' => $killers]);
@file_put_contents($cacheFile, $out);
echo $out;
