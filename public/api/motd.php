<?php
require_once 'config.php';
cors();

$pdo = getDB();

// GET: huidige mededeling (voor iedereen leesbaar)
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $stmt = $pdo->query("SELECT `key`, value FROM settings WHERE `key` IN ('motd_text','motd_enabled','motd_type','motd_until','motd_link')");
        $rows = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $rows[$r['key']] = $r['value'];
        echo json_encode([
            'text'    => $rows['motd_text'] ?? '',
            'enabled' => ($rows['motd_enabled'] ?? 'false') === 'true',
            'type'    => $rows['motd_type'] ?? 'info',
            'until'   => $rows['motd_until'] ?? '',
            'link'    => $rows['motd_link'] ?? '',
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
        $type    = (string)($data['type'] ?? 'info');
        if (!in_array($type, ['info', 'warning', 'success', 'event'], true)) $type = 'info';
        $until   = trim((string)($data['until'] ?? ''));   // ISO-datumtijd of leeg = nooit
        $link    = trim((string)($data['link'] ?? ''));
        if ($link !== '' && !preg_match('#^https?://#i', $link)) $link = '';
        $stmt = $pdo->prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?');
        $stmt->execute(['motd_text', $text, $text]);
        $stmt->execute(['motd_enabled', $enabled, $enabled]);
        $stmt->execute(['motd_type', $type, $type]);
        $stmt->execute(['motd_until', $until, $until]);
        $stmt->execute(['motd_link', $link, $link]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
