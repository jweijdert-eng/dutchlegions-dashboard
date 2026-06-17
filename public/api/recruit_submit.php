<?php
require_once 'config.php';
cors();

// Recruit dient z'n profiel in. De access-token wordt bij EVE geverifieerd; we
// slaan op onder het geverifieerde character-id (geen spoofing mogelijk).
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); echo json_encode(['error' => 'method']); exit; }

$in = json_decode(file_get_contents('php://input'), true);
$cid = eveVerify($in['token'] ?? '');
if (!$cid) { http_response_code(401); echo json_encode(['error' => 'invalid token']); exit; }

$data = is_array($in['data'] ?? null) ? $in['data'] : [];
$name = isset($data['name']) ? mb_substr((string)$data['name'], 0, 128) : '';

try {
    $pdo = getDB();
    $pdo->exec("CREATE TABLE IF NOT EXISTS recruits (
        character_id BIGINT PRIMARY KEY,
        name VARCHAR(128),
        data MEDIUMTEXT,
        status VARCHAR(20) DEFAULT 'new',
        created_at DATETIME,
        updated_at DATETIME
    )");
    $stmt = $pdo->prepare("INSERT INTO recruits (character_id, name, data, created_at, updated_at)
        VALUES (?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE name = VALUES(name), data = VALUES(data), updated_at = NOW()");
    $stmt->execute([$cid, $name, json_encode($data)]);
    echo json_encode(['ok' => true]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
