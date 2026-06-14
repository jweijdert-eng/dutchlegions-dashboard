<?php
require_once 'config.php';
cors();

$pdo = getDB();

// Accentkleur: elke geldige 6-cijferige hex (#rrggbb). Leeg = standaardthema.
function valid_hex(string $c): bool { return (bool)preg_match('/^#[0-9a-fA-F]{6}$/', $c); }

// GET: publieke site-config (accentkleur + handige links) — voor iedereen leesbaar.
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $stmt = $pdo->query("SELECT `key`, value FROM settings WHERE `key` IN ('theme_accent','corp_links')");
        $rows = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $rows[$r['key']] = $r['value'];

        $accent = $rows['theme_accent'] ?? '';
        if (!valid_hex($accent)) $accent = '';   // leeg = standaardthema

        $links = [];
        if (!empty($rows['corp_links'])) {
            $decoded = json_decode($rows['corp_links'], true);
            if (is_array($decoded)) $links = $decoded;
        }
        echo json_encode(['accent' => $accent, 'links' => $links]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

// POST: opslaan (alleen admin).
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if ((int)($data['characterId'] ?? 0) !== ADMIN_CHAR_ID) {
        http_response_code(403); echo json_encode(['error' => 'Forbidden']); exit;
    }
    try {
        $accent = strtolower(trim((string)($data['accent'] ?? '')));
        if (!valid_hex($accent)) $accent = '';

        // Links saneren: max 12, alleen label + http(s)-url.
        $links = [];
        foreach ((array)($data['links'] ?? []) as $l) {
            $label = trim((string)($l['label'] ?? ''));
            $url   = trim((string)($l['url'] ?? ''));
            if ($label === '' || !preg_match('#^https?://#i', $url)) continue;
            $links[] = ['label' => mb_substr($label, 0, 40), 'url' => mb_substr($url, 0, 300)];
            if (count($links) >= 12) break;
        }

        $stmt = $pdo->prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?');
        $stmt->execute(['theme_accent', $accent, $accent]);
        $json = json_encode($links);
        $stmt->execute(['corp_links', $json, $json]);
        echo json_encode(['ok' => true, 'accent' => $accent, 'links' => $links]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
