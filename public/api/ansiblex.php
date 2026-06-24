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
    $rows = [];
    foreach ($pdo->query("SELECT `key`, value FROM settings WHERE `key` IN ('jump_bridges','jump_bridges_updated','jump_bridges_updatedby')")->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $rows[$r['key']] = $r['value'];
    }
    $bridges = [];
    if (!empty($rows['jump_bridges'])) {
        $d = json_decode($rows['jump_bridges'], true);
        if (is_array($d)) $bridges = $d;
    }
    echo json_encode([
        'bridges'   => $bridges,
        'updatedAt' => isset($rows['jump_bridges_updated']) ? (int)$rows['jump_bridges_updated'] : null,
        'updatedBy' => $rows['jump_bridges_updatedby'] ?? null,
    ]);
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
    $stmt = $pdo->prepare("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?");
    $json = json_encode($bridges);
    $stmt->execute(['jump_bridges', $json, $json]);
    $now = (string)time();
    $stmt->execute(['jump_bridges_updated', $now, $now]);
    $by = mb_substr(trim((string)($data['updatedBy'] ?? '')), 0, 64);
    $stmt->execute(['jump_bridges_updatedby', $by, $by]);
    echo json_encode(['ok' => true, 'count' => count($bridges), 'updatedAt' => (int)$now, 'updatedBy' => $by]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
