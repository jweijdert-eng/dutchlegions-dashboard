<?php
require_once 'config.php';
cors();

// Publieke shoutbox op de login-pagina. GET = recente berichten (poll via after_id),
// POST = nieuw bericht (naam + tekst), admin DELETE = wissen.
$pdo = getDB();
$pdo->exec("CREATE TABLE IF NOT EXISTS guest_chat (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64), message VARCHAR(280),
    created_at DATETIME, ip VARCHAR(64)
)");

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $afterId = (int)($_GET['after_id'] ?? 0);
    try {
        if ($afterId > 0) {
            $stmt = $pdo->prepare('SELECT id, name, message, created_at FROM guest_chat WHERE id > ? ORDER BY id ASC LIMIT 100');
            $stmt->execute([$afterId]);
            echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
        } else {
            // Laatste 50, oudste eerst
            $rows = $pdo->query('SELECT id, name, message, created_at FROM guest_chat ORDER BY id DESC LIMIT 50')->fetchAll(PDO::FETCH_ASSOC);
            echo json_encode(array_reverse($rows));
        }
    } catch (Exception $e) { http_response_code(500); echo json_encode(['error' => $e->getMessage()]); }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data    = json_decode(file_get_contents('php://input'), true) ?? [];
    $name    = mb_substr(trim((string)($data['name'] ?? '')), 0, 64);
    $message = mb_substr(trim((string)($data['message'] ?? '')), 0, 280);
    if ($name === '' || $message === '') { http_response_code(400); echo json_encode(['error' => 'missing fields']); exit; }
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    try {
        // Simpele rate-limit: max 5 berichten per 10s per IP
        $rl = $pdo->prepare('SELECT COUNT(*) FROM guest_chat WHERE ip = ? AND created_at > (NOW() - INTERVAL 10 SECOND)');
        $rl->execute([$ip]);
        if ((int)$rl->fetchColumn() >= 5) { http_response_code(429); echo json_encode(['error' => 'te snel']); exit; }

        $stmt = $pdo->prepare('INSERT INTO guest_chat (name, message, created_at, ip) VALUES (?, ?, NOW(), ?)');
        $stmt->execute([$name, $message, $ip]);
        $id = (int)$pdo->lastInsertId();
        // Houd maximaal 500 berichten
        $pdo->exec('DELETE FROM guest_chat WHERE id <= (SELECT m FROM (SELECT MIN(id) m FROM (SELECT id FROM guest_chat ORDER BY id DESC LIMIT 500) t) s)');
        echo json_encode(['ok' => true, 'id' => $id]);
    } catch (Exception $e) { http_response_code(500); echo json_encode(['error' => $e->getMessage()]); }
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    $data = json_decode(file_get_contents('php://input'), true) ?? [];
    if ((int)($data['adminCharId'] ?? 0) !== ADMIN_CHAR_ID) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
    try {
        if (isset($data['id'])) $pdo->prepare('DELETE FROM guest_chat WHERE id = ?')->execute([(int)$data['id']]);
        else $pdo->exec('DELETE FROM guest_chat');
        echo json_encode(['ok' => true]);
    } catch (Exception $e) { http_response_code(500); echo json_encode(['error' => $e->getMessage()]); }
    exit;
}

http_response_code(405);
