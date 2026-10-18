<?php
require_once 'config.php';
cors();

$method = $_SERVER['REQUEST_METHOD'];

// Wie je bent komt uit het EVE-token, niet uit een meegestuurd character-ID: die zijn
// openbaar, dus anders kon iedereen andermans notities lezen, overschrijven en wissen.
if ($method === 'GET') {
    $charId = authCharId();
    if (!$charId) { http_response_code(403); echo json_encode(['error' => 'Niet ingelogd']); exit; }
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
    $data   = json_decode(file_get_contents('php://input'), true) ?? [];
    $charId = authCharId($data);
    if (!$charId) { http_response_code(403); echo json_encode(['error' => 'Niet ingelogd']); exit; }
    $note   = $data['note'] ?? null;
    if (!$note || empty($note['id'])) {
        http_response_code(400); echo json_encode(['error' => 'missing fields']); exit;
    }
    $id        = $note['id'];
    $title     = substr($note['title'] ?? '', 0, 255);
    $content   = $note['content'] ?? '';
    $updatedAt = (int)($note['updatedAt'] ?? (time() * 1000));
    $charName  = substr($data['characterName'] ?? '', 0, 100);
    try {
        $pdo  = getDB();
        // Het id is de sleutel: zonder deze check overschrijft een bestaand id andermans notitie.
        $van = $pdo->prepare('SELECT character_id FROM notes WHERE id = ?');
        $van->execute([$id]);
        $eigenaar = $van->fetchColumn();
        if ($eigenaar !== false && (int)$eigenaar !== $charId) { http_response_code(403); echo json_encode(['error' => 'Niet jouw notitie']); exit; }
        $stmt = $pdo->prepare('INSERT INTO notes (id, character_id, character_name, title, content, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE character_name = ?, title = ?, content = ?, updated_at = ?');
        $stmt->execute([$id, $charId, $charName, $title, $content, $updatedAt, $charName, $title, $content, $updatedAt]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($method === 'DELETE') {
    $data   = json_decode(file_get_contents('php://input'), true) ?? [];
    $charId = authCharId($data);
    if (!$charId) { http_response_code(403); echo json_encode(['error' => 'Niet ingelogd']); exit; }
    $id     = $data['id'] ?? '';
    if (!$id) { http_response_code(400); echo json_encode(['error' => 'missing fields']); exit; }
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
