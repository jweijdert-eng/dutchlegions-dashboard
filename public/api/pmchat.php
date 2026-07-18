<?php
require_once 'config.php';
cors();

// Privé 1-op-1 chat tussen een (niet-ingelogde) bezoeker en de recruiters/admin.
// Elke bezoeker heeft een eigen 'thread'-token (onraadbaar, in localStorage). Alleen
// wie het token heeft ziet die thread; de admin ziet alle threads.
$pdo = getDB();
$pdo->exec("CREATE TABLE IF NOT EXISTS chat_threads (
    thread VARCHAR(40) PRIMARY KEY, name VARCHAR(64),
    created_at DATETIME, last_at DATETIME, staff_unread INT DEFAULT 0
)");
$pdo->exec("CREATE TABLE IF NOT EXISTS chat_messages (
    id INT AUTO_INCREMENT PRIMARY KEY, thread VARCHAR(40), sender VARCHAR(10),
    staff_name VARCHAR(64), message VARCHAR(280), created_at DATETIME, INDEX(thread)
)");

$method = $_SERVER['REQUEST_METHOD'];
$body   = json_decode(file_get_contents('php://input'), true) ?? [];
$action = $_GET['action'] ?? ($body['action'] ?? '');
$cleanThread = fn($t) => preg_replace('/[^a-zA-Z0-9]/', '', (string)$t);
// Admin-check o.b.v. een geverifieerd EVE-token (body 'token' of query 'token'), niet de spoofbare adminCharId.
$isAdmin = function () use ($body) { $cid = authCharId($body); return $cid !== null && isAdminRole($cid); };

// ── Bezoeker: bericht sturen ────────────────────────────────────────────────
if ($method === 'POST' && $action === 'send') {
    $thread  = $cleanThread($body['thread'] ?? '');
    $name    = mb_substr(trim((string)($body['name'] ?? '')), 0, 64);
    $message = mb_substr(trim((string)($body['message'] ?? '')), 0, 280);
    if ($thread === '' || $name === '' || $message === '') { http_response_code(400); echo json_encode(['error' => 'missing']); exit; }
    $rl = $pdo->prepare('SELECT COUNT(*) FROM chat_messages WHERE thread = ? AND sender = "guest" AND created_at > (NOW() - INTERVAL 10 SECOND)');
    $rl->execute([$thread]);
    if ((int)$rl->fetchColumn() >= 5) { http_response_code(429); echo json_encode(['error' => 'te snel']); exit; }
    $pdo->prepare('INSERT INTO chat_threads (thread, name, created_at, last_at, staff_unread) VALUES (?, ?, NOW(), NOW(), 1)
        ON DUPLICATE KEY UPDATE name = VALUES(name), last_at = NOW(), staff_unread = staff_unread + 1')->execute([$thread, $name]);
    $pdo->prepare('INSERT INTO chat_messages (thread, sender, message, created_at) VALUES (?, "guest", ?, NOW())')->execute([$thread, $message]);
    echo json_encode(['ok' => true, 'id' => (int)$pdo->lastInsertId()]); exit;
}

// ── Bezoeker: berichten van eigen thread ophalen ────────────────────────────
if ($method === 'GET' && $action === 'thread') {
    $thread = $cleanThread($_GET['thread'] ?? '');
    $after  = (int)($_GET['after_id'] ?? 0);
    if ($thread === '') { echo json_encode([]); exit; }
    $stmt = $pdo->prepare('SELECT id, sender, staff_name, message, created_at FROM chat_messages WHERE thread = ? AND id > ? ORDER BY id ASC LIMIT 100');
    $stmt->execute([$thread, $after]);
    echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC)); exit;
}

// ── Admin: lijst van gesprekken ─────────────────────────────────────────────
if ($method === 'GET' && $action === 'threads') {
    if (!$isAdmin()) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
    $rows = $pdo->query('SELECT t.thread, t.name, t.last_at, t.staff_unread,
        (SELECT message FROM chat_messages m WHERE m.thread = t.thread ORDER BY id DESC LIMIT 1) AS last_msg
        FROM chat_threads t ORDER BY t.last_at DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$r) $r['staff_unread'] = (int)$r['staff_unread'];
    echo json_encode($rows); exit;
}

// ── Admin: berichten van een thread (markeert als gelezen) ───────────────────
if ($method === 'GET' && $action === 'messages') {
    if (!$isAdmin()) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
    $thread = $cleanThread($_GET['thread'] ?? '');
    $pdo->prepare('UPDATE chat_threads SET staff_unread = 0 WHERE thread = ?')->execute([$thread]);
    $stmt = $pdo->prepare('SELECT id, sender, staff_name, message, created_at FROM chat_messages WHERE thread = ? ORDER BY id ASC LIMIT 300');
    $stmt->execute([$thread]);
    echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC)); exit;
}

// ── Admin: antwoorden ───────────────────────────────────────────────────────
if ($method === 'POST' && $action === 'reply') {
    if (!$isAdmin()) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
    $thread  = $cleanThread($body['thread'] ?? '');
    $sname   = mb_substr(trim((string)($body['staff_name'] ?? 'Recruiter')), 0, 64);
    $message = mb_substr(trim((string)($body['message'] ?? '')), 0, 280);
    if ($thread === '' || $message === '') { http_response_code(400); echo json_encode(['error' => 'missing']); exit; }
    $pdo->prepare('INSERT INTO chat_messages (thread, sender, staff_name, message, created_at) VALUES (?, "staff", ?, ?, NOW())')->execute([$thread, $sname, $message]);
    $pdo->prepare('UPDATE chat_threads SET last_at = NOW() WHERE thread = ?')->execute([$thread]);
    echo json_encode(['ok' => true]); exit;
}

// ── Admin: gesprek verwijderen ──────────────────────────────────────────────
if ($method === 'DELETE') {
    if (!$isAdmin()) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }
    $thread = $cleanThread($body['thread'] ?? '');
    if ($thread !== '') {
        $pdo->prepare('DELETE FROM chat_messages WHERE thread = ?')->execute([$thread]);
        $pdo->prepare('DELETE FROM chat_threads WHERE thread = ?')->execute([$thread]);
    }
    echo json_encode(['ok' => true]); exit;
}

http_response_code(400); echo json_encode(['error' => 'bad action']);
