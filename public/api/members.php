<?php
require_once 'config.php';
cors();

$pdo = getDB();
ensureMembersSchema($pdo);
$method = $_SERVER['REQUEST_METHOD'];

// GET: alle members OF één character check (blocked? / allowed?)
if ($method === 'GET') {
    if (isset($_GET['characterId'])) {
        $stmt = $pdo->prepare('SELECT character_id, name, blocked, allowed FROM members WHERE character_id = ?');
        $stmt->execute([(int)$_GET['characterId']]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) { $row['blocked'] = (int)$row['blocked']; $row['allowed'] = (int)$row['allowed']; }
        echo json_encode($row ?: null);
    } else {
        $stmt = $pdo->query('SELECT character_id, name, last_seen, blocked, allowed FROM members ORDER BY last_seen DESC');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) { $r['blocked'] = (int)$r['blocked']; $r['allowed'] = (int)$r['allowed']; }
        echo json_encode($rows);
    }
    exit;
}

$body = json_decode(file_get_contents('php://input'), true) ?? [];
requireAdmin($body);  // geverifieerd EVE-token vereist (niet meer de spoofbare adminCharId)

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
    } elseif ($action === 'allow') {
        // Upsert: werkt ook voor characters die nog nooit hebben ingelogd (op naam toegevoegd).
        $name = trim((string)($body['name'] ?? ''));
        $pdo->prepare("INSERT INTO members (character_id, name, last_seen, allowed) VALUES (?, ?, '2000-01-01 00:00:00', 1)
            ON DUPLICATE KEY UPDATE allowed = 1")->execute([$charId, $name]);
        echo json_encode(['ok' => true]);
    } elseif ($action === 'disallow') {
        $pdo->prepare('UPDATE members SET allowed = 0 WHERE character_id = ?')->execute([$charId]);
        echo json_encode(['ok' => true]);
    } else {
        http_response_code(400); echo json_encode(['error' => 'Onbekende actie']);
    }
    exit;
}

http_response_code(405);
