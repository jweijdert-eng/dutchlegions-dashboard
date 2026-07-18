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
            if ($row['key'] === 'theme_accent') continue;        // string-waarde, via siteconfig.php
            if ($row['key'] === 'corp_links') continue;          // JSON-waarde, via siteconfig.php
            if ($row['key'] === 'auth_epoch') { $out['auth_epoch'] = $row['value']; continue; } // string, niet booleanen
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
    $data = json_decode(file_get_contents('php://input'), true) ?? [];
    requireAdmin($data);  // geverifieerd EVE-token vereist (niet meer de spoofbare characterId)
    try {
        $pdo = getDB();
        foreach (($data['settings'] ?? []) as $key => $value) {
            // auth_epoch is een string (tijdstempel); de rest zijn booleans.
            $val  = $key === 'auth_epoch' ? (string)$value : ($value ? 'true' : 'false');
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
