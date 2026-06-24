<?php
// Gedeelde Ansiblex/jump-bridge-lijst — leesbaar voor iedereen, schrijfbaar voor elk
// ingelogd corp-lid (i.t.t. siteconfig.php, dat alleen de admin mag schrijven). Slaat op
// in dezelfde `settings.jump_bridges`, zodat de Admin-editor én de Fleet-kaart 'm delen.
require_once 'config.php';
cors();
header('Content-Type: application/json');
header('Cache-Control: no-store');
$pdo = getDB();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $row = $pdo->query("SELECT value FROM settings WHERE `key` = 'jump_bridges'")->fetch(PDO::FETCH_ASSOC);
    $bridges = [];
    if ($row && !empty($row['value'])) {
        $d = json_decode($row['value'], true);
        if (is_array($d)) $bridges = $d;
    }
    echo json_encode(['bridges' => $bridges]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    $cid = eveVerify($data['token'] ?? '');
    if (!$cid) { http_response_code(403); echo json_encode(['error' => 'Niet ingelogd']); exit; }

    // Normaliseer + dedup (bidirectioneel: A»B en B»A worden één paar).
    $seen = [];
    $bridges = [];
    foreach ((array)($data['bridges'] ?? []) as $b) {
        if (!is_array($b) || count($b) < 2) continue;
        $a = mb_substr(strtoupper(trim((string)$b[0])), 0, 32);
        $c = mb_substr(strtoupper(trim((string)$b[1])), 0, 32);
        if ($a === '' || $c === '' || $a === $c) continue;
        $key = $a < $c ? "$a|$c" : "$c|$a";
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $bridges[] = [$a, $c];
        if (count($bridges) >= 200) break;
    }
    $json = json_encode($bridges);
    $stmt = $pdo->prepare("INSERT INTO settings (`key`, value) VALUES ('jump_bridges', ?) ON DUPLICATE KEY UPDATE value = ?");
    $stmt->execute([$json, $json]);
    echo json_encode(['ok' => true, 'count' => count($bridges)]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
