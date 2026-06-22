<?php
// Top Miners-ranglijst. Mining-data is privé per character, dus elk lid postt z'n
// EIGEN maand-totaal (m³ + ISK) vanuit de Mining-pagina; de GET levert de optelsom.
require_once 'config.php';
cors();

try {
    $pdo = getDB();
    $pdo->exec("CREATE TABLE IF NOT EXISTS miners (
        character_id BIGINT PRIMARY KEY,
        name VARCHAR(128),
        ym   VARCHAR(7),
        m3   BIGINT DEFAULT 0,
        isk  BIGINT DEFAULT 0,
        updated_at DATETIME
    )");

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $d    = json_decode(file_get_contents('php://input'), true) ?? [];
        $id   = (int)($d['characterId'] ?? 0);
        $name = mb_substr(trim((string)($d['name'] ?? '')), 0, 128);
        $m3   = max(0, (int)($d['m3'] ?? 0));
        $isk  = max(0, (int)($d['isk'] ?? 0));
        if (!$id) { http_response_code(400); echo json_encode(['error' => 'no id']); exit; }
        $ym = date('Y-m');
        // De client stuurt het ABSOLUTE maand-totaal → overschrijven.
        $pdo->prepare("INSERT INTO miners (character_id, name, ym, m3, isk, updated_at)
                       VALUES (?,?,?,?,?,NOW())
                       ON DUPLICATE KEY UPDATE name=VALUES(name), ym=VALUES(ym), m3=VALUES(m3), isk=VALUES(isk), updated_at=NOW()")
            ->execute([$id, $name, $ym, $m3, $isk]);
        echo json_encode(['ok' => true]);
        exit;
    }

    // GET → top miners van DEZE maand (alleen wie daadwerkelijk gemined heeft)
    $stmt = $pdo->prepare("SELECT character_id, name, m3, isk, updated_at FROM miners WHERE ym = ? AND m3 > 0 ORDER BY m3 DESC LIMIT 50");
    $stmt->execute([date('Y-m')]);
    echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
