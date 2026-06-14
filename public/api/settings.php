<?php
require_once 'config.php';
cors();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $pdo  = getDB();
        $stmt = $pdo->query('SELECT `key`, value FROM settings');
        $out  = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (strpos($row['key'], 'motd') === 0) continue;     // motd via motd.php
            if ($row['key'] === 'github_pat') continue;          // geheim, niet uitlekken
            $out[$row['key']] = $row['value'] === 'true';
        }
        echo json_encode($out);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if ((int)($data['characterId'] ?? 0) !== ADMIN_CHAR_ID) {
        http_response_code(403); echo json_encode(['error' => 'Forbidden']); exit;
    }
    try {
        $pdo = getDB();
        foreach (($data['settings'] ?? []) as $key => $value) {
            $val  = $value ? 'true' : 'false';
            $stmt = $pdo->prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?');
            $stmt->execute([$key, $val, $val]);
        }
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
