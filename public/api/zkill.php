<?php
// Proxy voor zKillboard-corp/alliance-kills: zKill stuurt geen CORS-headers en eist een
// nette User-Agent, dus we halen het server-side op (met korte file-cache).
require_once 'config.php';
cors();

$type = preg_match('/^(corporationID|allianceID)$/', $_GET['type'] ?? '') ? $_GET['type'] : 'corporationID';
$id   = (int)($_GET['id'] ?? 0);
if (!$id) { http_response_code(400); echo json_encode(['error' => 'no id']); exit; }

header('Content-Type: application/json');

$cacheFile = sys_get_temp_dir() . "/zkill_{$type}_{$id}.json";
if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < 300) {
    echo file_get_contents($cacheFile);
    exit;
}

$ch = curl_init("https://zkillboard.com/api/kills/{$type}/{$id}/");
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
    @file_put_contents($cacheFile, $resp);
    echo $resp;
} elseif (is_file($cacheFile)) {
    echo file_get_contents($cacheFile);  // val terug op (verlopen) cache bij zKill-storing
} else {
    http_response_code(502);
    echo json_encode(['error' => "zkill HTTP $code"]);
}
