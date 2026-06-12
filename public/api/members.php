<?php
require_once 'config.php';
cors();

$pdo = getDB();
$method = $_SERVER['REQUEST_METHOD'];

// GET: alle members OF één character check (blocked?)
if ($method === 'GET') {
    if (isset($_GET['characterId'])) {
        $stmt = $pdo->prepare('SELECT character_id, name, blocked FROM members WHERE character_id = ?');
        $stmt->execute([(int)$_GET['characterId']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        echo json_encode($row ?: null);
    } else {
        $stmt = $pdo->query('SELECT character_id, name, last_seen, blocked FROM members ORDER BY last_seen DESC');
        echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
    }
    exit;
}

$body = json_decode(file_get_contents('php://input'), true) ?? [];
$adminId = (int)($body['adminCharId'] ?? 0);
if ($adminId !== ADMIN_CHAR_ID) { http_response_code(403); echo json_encode(['error' => 'Geen toegang']); exit; }

$charId = (int)($body['characterId'] ?? 0);
if (!$charId) { http_response_code(400); echo json_encode(['error' => 'characterId vereist']); exit; }

// DELETE: verwijder member
if ($method === 'DELETE') {
    $pdo->prepare('DELETE FROM members WHERE character_id = ?')->execute([$charId]);
    echo json_encode(['ok' => true]);
    exit;
}

// POST: blokkeer of deblokkeer
if ($method === 'POST') {
    $action = $body['action'] ?? '';
    if ($action === 'block') {
        $pdo->prepare('UPDATE members SET blocked = 1 WHERE character_id = ?')->execute([$charId]);
        echo json_encode(['ok' => true]);
    } elseif ($action === 'unblock') {
        $pdo->prepare('UPDATE members SET blocked = 0 WHERE character_id = ?')->execute([$charId]);
        echo json_encode(['ok' => true]);
    } else {
        http_response_code(400); echo json_encode(['error' => 'Onbekende actie']);
    }
    exit;
}

http_response_code(405);
