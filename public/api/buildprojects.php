<?php
require_once 'config.php';
cors();

// Bouwprojecten per character. Eén project = een JSON-blob (doel, ME, buy/build-
// keuzes en voortgang per materiaal); de client rekent de materiaalboom zelf uit
// de gebundelde SDE uit, dus de server hoeft alleen op te slaan/terug te geven.
$pdo = getDB();
$pdo->exec("CREATE TABLE IF NOT EXISTS build_projects (
    id VARCHAR(40) PRIMARY KEY,
    character_id BIGINT,
    character_name VARCHAR(100),
    name VARCHAR(255),
    data LONGTEXT,
    updated_at BIGINT,
    INDEX(character_id)
)");

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $charId = (int)($_GET['characterId'] ?? 0);
    if (!$charId) { http_response_code(400); echo json_encode(['error' => 'missing characterId']); exit; }
    try {
        $stmt = $pdo->prepare('SELECT data FROM build_projects WHERE character_id = ? ORDER BY updated_at DESC');
        $stmt->execute([$charId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $p = json_decode($row['data'], true);
            if (is_array($p)) $out[] = $p;
        }
        echo json_encode($out);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($method === 'POST') {
    $body    = json_decode(file_get_contents('php://input'), true) ?? [];
    $charId  = (int)($body['characterId'] ?? 0);
    $project = $body['project'] ?? null;
    if (!$charId || !is_array($project) || empty($project['id'])) {
        http_response_code(400); echo json_encode(['error' => 'missing fields']); exit;
    }
    $id        = substr((string)$project['id'], 0, 40);
    $name      = substr((string)($project['name'] ?? 'Naamloos'), 0, 255);
    $updatedAt = (int)($project['updatedAt'] ?? (time() * 1000));
    $charName  = substr((string)($body['characterName'] ?? ''), 0, 100);
    $data      = json_encode($project, JSON_UNESCAPED_UNICODE);
    try {
        $stmt = $pdo->prepare('INSERT INTO build_projects (id, character_id, character_name, name, data, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE character_name = ?, name = ?, data = ?, updated_at = ?');
        $stmt->execute([$id, $charId, $charName, $name, $data, $updatedAt, $charName, $name, $data, $updatedAt]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

if ($method === 'DELETE') {
    $body   = json_decode(file_get_contents('php://input'), true) ?? [];
    $charId = (int)($body['characterId'] ?? 0);
    $id     = substr((string)($body['id'] ?? ''), 0, 40);
    if (!$charId || $id === '') { http_response_code(400); echo json_encode(['error' => 'missing fields']); exit; }
    try {
        $stmt = $pdo->prepare('DELETE FROM build_projects WHERE id = ? AND character_id = ?');
        $stmt->execute([$id, $charId]);
        echo json_encode(['ok' => true]);
    } catch (Exception $e) {
        http_response_code(500); echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

http_response_code(405);
