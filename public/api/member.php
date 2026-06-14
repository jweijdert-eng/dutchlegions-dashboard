<?php
require_once 'config.php';
cors();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit; }

$id = (int)($_GET['characterId'] ?? 0);
if (!$id) { http_response_code(400); echo json_encode(['error' => 'characterId vereist']); exit; }

try {
    $pdo = getDB();

    $m = $pdo->prepare('SELECT character_id, name, last_seen, blocked FROM members WHERE character_id = ?');
    $m->execute([$id]);
    $member = $m->fetch(PDO::FETCH_ASSOC);
    if (!$member) { echo json_encode(null); exit; }

    $s = $pdo->prepare('SELECT COUNT(*) AS total, MIN(logged_at) AS first, MAX(logged_at) AS last FROM login_log WHERE character_id = ?');
    $s->execute([$id]);
    $stats = $s->fetch(PDO::FETCH_ASSOC);

    $r = $pdo->prepare('SELECT logged_at FROM login_log WHERE character_id = ? ORDER BY logged_at DESC LIMIT 30');
    $r->execute([$id]);
    $recent = array_column($r->fetchAll(PDO::FETCH_ASSOC), 'logged_at');

    echo json_encode([
        'character_id'  => (int)$member['character_id'],
        'name'          => $member['name'],
        'last_seen'     => $member['last_seen'],
        'blocked'       => (int)$member['blocked'],
        'total_logins'  => (int)$stats['total'],
        'first_login'   => $stats['first'],
        'last_login'    => $stats['last'],
        'recent_logins' => $recent,
    ]);
} catch (Exception $e) {
    http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
}
