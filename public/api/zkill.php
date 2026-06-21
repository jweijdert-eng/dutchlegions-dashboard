<?php
// Proxy voor zKillboard-corp/alliance-data: zKill stuurt geen CORS-headers en eist een
// nette User-Agent, dus we halen het server-side op (met korte file-cache).
require_once 'config.php';
cors();

// Belangrijk: LiteSpeed mag deze dynamische respons NIET cachen. Door 'Vary: User-Agent'
// bleef anders een vroege lege/204-respons hangen voor browser-user-agents (curl kreeg
// wél 200). no-store + de LiteSpeed-specifieke header zetten dat uit.
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-LiteSpeed-Cache-Control: no-cache');

$type = preg_match('/^(corporationID|allianceID)$/', $_GET['type'] ?? '') ? $_GET['type'] : 'corporationID';
$id   = (int)($_GET['id'] ?? 0);
$mode = isset($_GET['stats']) ? 'stats' : 'kills';   // stats=top killers, anders recente kills
if (!$id) { http_response_code(400); echo json_encode(['error' => 'no id']); exit; }

$cacheFile = sys_get_temp_dir() . "/zkill_{$mode}_{$type}_{$id}.json";
if (is_file($cacheFile) && filesize($cacheFile) > 2 && (time() - filemtime($cacheFile)) < 300) {
    echo file_get_contents($cacheFile);
    exit;
}

$ch = curl_init("https://zkillboard.com/api/{$mode}/{$type}/{$id}/");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 20,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_HTTPHEADER     => [
        'Accept: application/json',
        'User-Agent: DutchLegionsDashboard/1.0 (j.weijdert@gmail.com)',
    ],
]);
$resp = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($code === 200 && $resp !== false && $resp !== '') {
    if ($mode === 'stats') {
        // Server-side reduceren tot een mini-JSON met alleen de top killers
        // (scheelt ~49KB en voorkomt rare edge-effecten op de grote blob).
        $j = json_decode($resp, true);
        $values = [];
        foreach (($j['topLists'] ?? []) as $tl) {
            if (($tl['type'] ?? '') === 'character') { $values = $tl['values'] ?? []; break; }
        }
        $killers = [];
        foreach (array_slice($values, 0, 10) as $v) {
            $killers[] = [
                'characterID'   => (int)($v['characterID'] ?? 0),
                'characterName' => (string)($v['characterName'] ?? ''),
                'kills'         => (int)($v['kills'] ?? 0),
            ];
        }
        $out = json_encode(['topKillers' => $killers]);
    } else {
        $out = $resp;
    }
    @file_put_contents($cacheFile, $out);
    echo $out;
} elseif (is_file($cacheFile) && filesize($cacheFile) > 2) {
    echo file_get_contents($cacheFile);  // val terug op cache bij zKill-storing
} else {
    http_response_code(502);
    echo json_encode($mode === 'stats' ? ['topKillers' => []] : ['error' => "zkill HTTP $code"]);
}
