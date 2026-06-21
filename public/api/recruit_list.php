<?php
require_once 'config.php';
cors();

// Lijst van aanmeldingen — alleen voor de admin/recruiter (token bij EVE geverifieerd).
$cid = eveVerify($_GET['token'] ?? '');
if (!$cid || !isRecruitAdmin($cid)) { http_response_code(403); echo json_encode(['error' => 'forbidden']); exit; }

try {
    $pdo = getDB();
    $pdo->exec("CREATE TABLE IF NOT EXISTS recruits (
        character_id BIGINT PRIMARY KEY, name VARCHAR(128), data MEDIUMTEXT,
        status VARCHAR(20) DEFAULT 'new', notes MEDIUMTEXT, created_at DATETIME, updated_at DATETIME
    )");
    // Migratie: notes-kolom toevoegen aan een bestaande tabel (negeer als 'ie er al is).
    try { $pdo->exec("ALTER TABLE recruits ADD COLUMN notes MEDIUMTEXT"); } catch (Exception $e) { /* bestaat al */ }

    // Recruiter-notitie opslaan (POST: { id, notes })
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $body  = json_decode(file_get_contents('php://input'), true) ?? [];
        $id    = (int)($body['id'] ?? 0);
        $notes = mb_substr((string)($body['notes'] ?? ''), 0, 4000);
        if ($id) $pdo->prepare("UPDATE recruits SET notes = ? WHERE character_id = ?")->execute([$notes, $id]);
        echo json_encode(['ok' => true]); exit;
    }

    // Verwijderen (admin): ?delete=<character_id>
    if (isset($_GET['delete'])) {
        $pdo->prepare("DELETE FROM recruits WHERE character_id = ?")->execute([(int)$_GET['delete']]);
        echo json_encode(['ok' => true]); exit;
    }
    // Status/fase zetten: ?status=accepted&id=<character_id>
    if (isset($_GET['status'], $_GET['id'])) {
        $pdo->prepare("UPDATE recruits SET status = ?, updated_at = NOW() WHERE character_id = ?")
            ->execute([substr((string)$_GET['status'], 0, 20), (int)$_GET['id']]);
        echo json_encode(['ok' => true]); exit;
    }

    $rows = $pdo->query("SELECT character_id, name, data, status, notes, created_at, updated_at
        FROM recruits ORDER BY updated_at DESC")->fetchAll(PDO::FETCH_ASSOC);
    echo json_encode($rows);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
