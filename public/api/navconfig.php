<?php
require_once 'config.php';
cors();

// Gedeelde menu-indeling (groepen, volgorde, eigen namen). Voor iedereen leesbaar;
// alleen de admin kan opslaan. Bewaard als één JSON-blob in de settings-tabel.
$pdo = getDB();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $row = $pdo->query("SELECT value FROM settings WHERE `key` = 'nav_menu'")->fetch(PDO::FETCH_ASSOC);
        $out = ['layout' => [], 'labels' => (object)[]];
        if ($row && !empty($row['value'])) {
            $d = json_decode($row['value'], true);
            if (is_array($d)) {
                if (isset($d['layout']) && is_array($d['layout'])) $out['layout'] = $d['layout'];
                if (isset($d['labels']) && is_array($d['labels'])) $out['labels'] = $d['labels'] ?: (object)[];
            }
        }
        echo json_encode($out);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if ((int)($data['characterId'] ?? 0) !== ADMIN_CHAR_ID) {
        http_response_code(403); echo json_encode(['error' => 'Forbidden']); exit;
    }
    try {
        $layout = is_array($data['layout'] ?? null) ? $data['layout'] : [];
        $labels = is_array($data['labels'] ?? null) ? $data['labels'] : [];
        $payload = json_encode(['layout' => $layout, 'labels' => $labels], JSON_UNESCAPED_UNICODE);
        if (strlen($payload) > 30000) { http_response_code(413); echo json_encode(['error' => 'too large']); exit; }
        $pdo->prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?')
            ->execute(['nav_menu', $payload, $payload]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
