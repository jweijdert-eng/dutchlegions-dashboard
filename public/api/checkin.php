<?php
require_once 'config.php';
cors();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }

$data = json_decode(file_get_contents('php://input'), true);
$data = is_array($data) ? $data : [];
$id   = requireMember($data);            // character-id uit het geverifieerde token, niet uit de body
$name = mb_substr(trim((string)($data['name'] ?? '')), 0, 128);

if (!$id || !$name) { http_response_code(400); echo json_encode(['error' => 'missing fields']); exit; }

try {
    $pdo = getDB();
    $stmt = $pdo->prepare('INSERT INTO members (character_id, name, last_seen) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE name = ?, last_seen = NOW()');
    $stmt->execute([$id, $name, $name]);

    $type = $data['type'] ?? 'heartbeat';
    if ($type === 'login') {
        $pdo->prepare('INSERT INTO login_log (character_id, logged_at) VALUES (?, NOW())')->execute([$id]);
    }

    echo json_encode(['ok' => true]);
} catch (Exception $e) {
    http_response_code(500);
    serverFout($e);
}
