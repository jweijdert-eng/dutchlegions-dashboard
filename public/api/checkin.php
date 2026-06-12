<?php
require_once 'config.php';
cors();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }

$data = json_decode(file_get_contents('php://input'), true);
$id   = (int)($data['characterId'] ?? 0);
$name = trim($data['name'] ?? '');

if (!$id || !$name) { http_response_code(400); echo json_encode(['error' => 'missing fields']); exit; }

try {
    $pdo = getDB();
    $stmt = $pdo->prepare('INSERT INTO members (character_id, name, last_seen) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE name = ?, last_seen = NOW()');
    $stmt->execute([$id, $name, $name]);
    echo json_encode(['ok' => true]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
