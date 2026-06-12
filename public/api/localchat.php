<?php
require_once 'config.php';
cors();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $afterId = (int)($_GET['after_id'] ?? 0);
    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare('SELECT id, sender, message, time FROM localchat WHERE id > ? ORDER BY id ASC LIMIT 200');
        $stmt->execute([$afterId]);
        echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data    = json_decode(file_get_contents('php://input'), true);
    $sender  = substr(trim($data['sender']  ?? ''), 0, 255);
    $message = trim($data['message'] ?? '');
    $time    = substr(trim($data['time']    ?? ''), 0, 30);
    if (!$sender || !$message) { http_response_code(400); echo json_encode(['error' => 'missing fields']); exit; }
    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare('INSERT INTO localchat (sender, message, time) VALUES (?, ?, ?)');
        $stmt->execute([$sender, $message, $time]);
        $id = (int)$pdo->lastInsertId();
        // Houd maximaal 2000 berichten bij
        $pdo->exec('DELETE FROM localchat WHERE id <= (SELECT min_id FROM (SELECT MIN(id) as min_id FROM (SELECT id FROM localchat ORDER BY id DESC LIMIT 2000) t) s)');
        echo json_encode(['ok' => true, 'id' => $id]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
