<?php
require_once 'config.php';
cors();

try {
    $pdo = getDB();
    $pdo->exec("CREATE TABLE IF NOT EXISTS page_views (
        id INT AUTO_INCREMENT PRIMARY KEY,
        character_id BIGINT NOT NULL,
        page VARCHAR(64) NOT NULL,
        viewed_at DATETIME NOT NULL,
        INDEX idx_viewed (viewed_at),
        INDEX idx_page (page)
    )");

    // POST: registreer een page view
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $data = json_decode(file_get_contents('php://input'), true);
        $id   = (int)($data['characterId'] ?? 0);
        $page = substr(trim($data['page'] ?? ''), 0, 64);
        if (!$id || $page === '') { http_response_code(400); echo json_encode(['error' => 'missing']); exit; }
        $pdo->prepare('INSERT INTO page_views (character_id, page, viewed_at) VALUES (?, ?, NOW())')->execute([$id, $page]);
        echo json_encode(['ok' => true]);
        exit;
    }

    // GET: aggregaten per pagina (laatste 30 dagen)
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $stmt = $pdo->query("
            SELECT page, COUNT(*) AS views, COUNT(DISTINCT character_id) AS users
            FROM page_views
            WHERE viewed_at >= NOW() - INTERVAL 30 DAY
            GROUP BY page ORDER BY views DESC
        ");
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$r) { $r['views'] = (int)$r['views']; $r['users'] = (int)$r['users']; }
        echo json_encode($rows);
        exit;
    }

    http_response_code(405);
} catch (Exception $e) {
    http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
}
