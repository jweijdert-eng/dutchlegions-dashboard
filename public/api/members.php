<?php
require_once 'config.php';
cors();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit; }

try {
    $pdo  = getDB();
    $stmt = $pdo->query('SELECT character_id, name, last_seen FROM members ORDER BY last_seen DESC');
    echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
