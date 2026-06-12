<?php
require_once 'config.php';
cors();

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $charId = (int)($_GET['characterId'] ?? 0);
    if (!$charId) { http_response_code(400); echo json_encode(['error' => 'missing characterId']); exit; }
    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare('SELECT id, title, content, updated_at FROM notes WHERE character_id = ? ORDER BY updated_at DESC');
        $stmt->execute([$charId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            $row['updatedAt'] = (int)$row['updated_at'];
            unset($row['updated_at']);
        }
        echo json_encode($rows);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($method === 'POST') {
    $data   = json_decode(file_get_contents('php://input'), true);
    $charId = (int)($data['characterId'] ?? 0);
    $note   = $data['note'] ?? null;
    if (!$charId || !$note || empty($note['id'])) {
        http_response_code(400); echo json_encode(['error' => 'missing fields']); exit;
    }
    $id        = $note['id'];
    $title     = substr($note['title'] ?? '', 0, 255);
    $content   = $note['content'] ?? '';
    $updatedAt = (int)($note['updatedAt'] ?? (time() * 1000));
    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare('INSERT INTO notes (id, character_id, title, content, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = ?, content = ?, updated_at = ?');
        $stmt->execute([$id, $charId, $title, $content, $updatedAt, $title, $content, $updatedAt]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($method === 'DELETE') {
    $data   = json_decode(file_get_contents('php://input'), true);
    $charId = (int)($data['characterId'] ?? 0);
    $id     = $data['id'] ?? '';
    if (!$charId || !$id) { http_response_code(400); echo json_encode(['error' => 'missing fields']); exit; }
    try {
        $pdo  = getDB();
        $stmt = $pdo->prepare('DELETE FROM notes WHERE id = ? AND character_id = ?');
        $stmt->execute([$id, $charId]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
