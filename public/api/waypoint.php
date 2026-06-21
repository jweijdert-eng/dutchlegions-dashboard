<?php
// Zet de in-game autopilot-waypoint via ESI, server-side. De directe browser-POST
// naar esi.evetech.net wordt op sommige machines door een ad-blocker/tracking-preventie
// onderschept (nep-204), waardoor de route nooit echt bij ESI aankomt. Via deze proxy
// loopt de call vanaf de server → geen client-blocker.
require_once 'config.php';
cors();

$body  = json_decode(file_get_contents('php://input'), true) ?? [];
$token = (string)($body['token'] ?? '');
$dest  = (int)($body['dest'] ?? 0);
$clear = !empty($body['clear']) ? 'true' : 'false';
$begin = !empty($body['begin']) ? 'true' : 'false';
if ($token === '' || $dest <= 0) { http_response_code(400); echo json_encode(['ok' => false, 'status' => 400]); exit; }

$url = "https://esi.evetech.net/latest/ui/autopilot/waypoint/"
     . "?add_to_beginning={$begin}&clear_other_waypoints={$clear}&destination_id={$dest}&datasource=tranquility";

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => '',
    CURLOPT_TIMEOUT        => 15,
    CURLOPT_HTTPHEADER     => [
        'Authorization: Bearer ' . $token,
        'Content-Type: application/json',
        'Accept: application/json',
    ],
]);
$resp = curl_exec($ch);
$code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

echo json_encode([
    'ok'     => $code >= 200 && $code < 300,
    'status' => $code,
    'error'  => ($code >= 200 && $code < 300) ? null : (is_string($resp) ? substr($resp, 0, 200) : null),
]);
