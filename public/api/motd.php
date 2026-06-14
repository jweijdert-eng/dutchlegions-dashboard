<?php
require_once 'config.php';
cors();

$pdo = getDB();

// GET: huidige mededeling (voor iedereen leesbaar)
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $stmt = $pdo->query("SELECT `key`, value FROM settings WHERE `key` IN ('motd_text','motd_enabled')");
        $rows = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $rows[$r['key']] = $r['value'];
        echo json_encode([
            'text'    => $rows['motd_text'] ?? '',
            'enabled' => ($rows['motd_enabled'] ?? 'false') === 'true',
        ]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

// POST: mededeling instellen (alleen admin)
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if ((int)($data['characterId'] ?? 0) !== ADMIN_CHAR_ID) {
        http_response_code(403); echo json_encode(['error' => 'Forbidden']); exit;
    }
    try {
        $text    = (string)($data['text'] ?? '');
        $enabled = !empty($data['enabled']) ? 'true' : 'false';
        $stmt = $pdo->prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?');
        $stmt->execute(['motd_text', $text, $text]);
        $stmt->execute(['motd_enabled', $enabled, $enabled]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
