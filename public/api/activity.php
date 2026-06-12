<?php
require_once 'config.php';
cors();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit; }

try {
    $pdo = getDB();

    // Actieve members uit members tabel
    $row = $pdo->query("
        SELECT
          COUNT(*) AS total,
          SUM(last_seen >= NOW() - INTERVAL 1 DAY)  AS today,
          SUM(last_seen >= NOW() - INTERVAL 7 DAY)  AS week,
          SUM(last_seen >= NOW() - INTERVAL 30 DAY) AS month
        FROM members
    ")->fetch(PDO::FETCH_ASSOC);

    // Dagelijkse unieke logins laatste 30 dagen
    $stmt = $pdo->query("
        SELECT DATE(logged_at) AS day, COUNT(DISTINCT character_id) AS count
        FROM login_log
        WHERE logged_at >= NOW() - INTERVAL 30 DAY
        GROUP BY DATE(logged_at)
        ORDER BY day ASC
    ");
    $daily = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($daily as &$d) $d['count'] = (int)$d['count'];

    echo json_encode([
        'total' => (int)$row['total'],
        'today' => (int)$row['today'],
        'week'  => (int)$row['week'],
        'month' => (int)$row['month'],
        'daily' => $daily,
    ]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
