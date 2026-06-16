<?php
require_once 'config.php';
cors();

$pdo = getDB();

// Accentkleur: elke geldige 6-cijferige hex (#rrggbb). Leeg = standaardthema.
function valid_hex(string $c): bool { return (bool)preg_match('/^#[0-9a-fA-F]{6}$/', $c); }

// GET: publieke site-config (accentkleur + handige links) — voor iedereen leesbaar.
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    try {
        $stmt = $pdo->query("SELECT `key`, value FROM settings WHERE `key` IN ('theme_accent','corp_links','jump_bridges','intel_channels')");
        $rows = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $rows[$r['key']] = $r['value'];

        $accent = $rows['theme_accent'] ?? '';
        if (!valid_hex($accent)) $accent = '';   // leeg = standaardthema

        $links = [];
        if (!empty($rows['corp_links'])) {
            $decoded = json_decode($rows['corp_links'], true);
            if (is_array($decoded)) $links = $decoded;
        }

        $bridges = [];
        if (!empty($rows['jump_bridges'])) {
            $decoded = json_decode($rows['jump_bridges'], true);
            if (is_array($decoded)) $bridges = $decoded;
        }

        $intelChannels = [];
        if (!empty($rows['intel_channels'])) {
            $decoded = json_decode($rows['intel_channels'], true);
            if (is_array($decoded)) $intelChannels = $decoded;
        }
        echo json_encode(['accent' => $accent, 'links' => $links, 'bridges' => $bridges, 'intelChannels' => $intelChannels]);
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

        // Jump bridges saneren: paren van twee systeem-namen, max 100.
        $bridges = [];
        foreach ((array)($data['bridges'] ?? []) as $b) {
            if (!is_array($b) || count($b) < 2) continue;
            $a = strtoupper(trim((string)$b[0]));
            $c = strtoupper(trim((string)$b[1]));
            if ($a === '' || $c === '') continue;
            $bridges[] = [mb_substr($a, 0, 32), mb_substr($c, 0, 32)];
            if (count($bridges) >= 100) break;
        }

        // Intel-kanalen saneren: { prefix, label }, prefix verplicht, max 30.
        $intelChannels = [];
        foreach ((array)($data['intelChannels'] ?? []) as $c) {
            $prefix = trim((string)($c['prefix'] ?? ''));
            $label  = trim((string)($c['label'] ?? ''));
            if ($prefix === '') continue;
            $intelChannels[] = ['prefix' => mb_substr($prefix, 0, 64), 'label' => mb_substr($label, 0, 40)];
            if (count($intelChannels) >= 30) break;
        }

        $stmt = $pdo->prepare('INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?');
        $stmt->execute(['theme_accent', $accent, $accent]);
        $json = json_encode($links);
        $stmt->execute(['corp_links', $json, $json]);
        $bjson = json_encode($bridges);
        $stmt->execute(['jump_bridges', $bjson, $bjson]);
        $cjson = json_encode($intelChannels);
        $stmt->execute(['intel_channels', $cjson, $cjson]);
        echo json_encode(['ok' => true, 'accent' => $accent, 'links' => $links, 'bridges' => $bridges, 'intelChannels' => $intelChannels]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
