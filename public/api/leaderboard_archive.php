<?php
// Maandelijks leaderboard-archief. zkill.php schrijft elke (verse) load een snapshot van
// de huidige-maand-top-10 weg; zodra een maand voorbij is bevriest die vanzelf. Dit
// endpoint geeft de afgeronde (voorbije) maanden terug — nieuwste eerst. Read-only.
require_once 'config.php';
cors();
header('Cache-Control: no-cache');

$id = (int)($_GET['id'] ?? 0);
if (!$id) { http_response_code(400); echo json_encode(['error' => 'no id']); exit; }

try {
    $pdo = getDB();
    $pdo->exec("CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
        corp_id BIGINT NOT NULL, ym VARCHAR(6) NOT NULL,
        data MEDIUMTEXT, updated_at DATETIME,
        PRIMARY KEY (corp_id, ym))");
    // Alleen afgeronde maanden (strikt kleiner dan de lopende YYYYMM).
    $st = $pdo->prepare("SELECT ym, data, updated_at FROM leaderboard_snapshots
        WHERE corp_id = ? AND ym < ? ORDER BY ym DESC");
    $st->execute([$id, date('Ym')]);
    $months = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $rows = json_decode($r['data'], true);
        if (!is_array($rows) || !$rows) continue;
        $months[] = [
            'ym'       => $r['ym'],
            'rows'     => array_slice($rows, 0, 10),
            'frozenAt' => $r['updated_at'],
        ];
    }
    echo json_encode(['months' => $months]);
} catch (Exception $e) {
    echo json_encode(['months' => []]);
}
