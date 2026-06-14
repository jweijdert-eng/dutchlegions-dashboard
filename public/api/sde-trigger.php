<?php
require_once 'config.php';
cors();

$pdo = getDB();

function pat(PDO $pdo): string {
    $r = $pdo->query("SELECT value FROM settings WHERE `key` = 'github_pat'")->fetch(PDO::FETCH_ASSOC);
    return $r ? trim($r['value']) : '';
}

// GET: is er een token ingesteld? (token zelf wordt nooit teruggegeven)
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode(['hasPat' => pat($pdo) !== '']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $data = json_decode(file_get_contents('php://input'), true);
    if ((int)($data['characterId'] ?? 0) !== ADMIN_CHAR_ID) {
        http_response_code(403); echo json_encode(['error' => 'Forbidden']); exit;
    }
    $action = $data['action'] ?? '';

    // Token opslaan (in DB, niet in de repo)
    if ($action === 'save') {
        $token = trim($data['pat'] ?? '');
        $stmt = $pdo->prepare("INSERT INTO settings (`key`, value) VALUES ('github_pat', ?) ON DUPLICATE KEY UPDATE value = ?");
        $stmt->execute([$token, $token]);
        echo json_encode(['ok' => true]);
        exit;
    }

    // Workflow nu starten
    if ($action === 'run') {
        $token = pat($pdo);
        if ($token === '') { http_response_code(400); echo json_encode(['error' => 'Geen GitHub-token ingesteld']); exit; }
        $ch = curl_init('https://api.github.com/repos/' . GITHUB_REPO . '/actions/workflows/update-sde.yml/dispatches');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode(['ref' => 'main']),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $token,
                'Accept: application/vnd.github+json',
                'X-GitHub-Api-Version: 2022-11-28',
                'Content-Type: application/json',
                'User-Agent: dutchlegions-dashboard',
            ],
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code === 204) { echo json_encode(['ok' => true]); }
        else { http_response_code(502); echo json_encode(['error' => "GitHub gaf HTTP $code", 'detail' => $resp]); }
        exit;
    }

    http_response_code(400); echo json_encode(['error' => 'Onbekende actie']);
    exit;
}

http_response_code(405);
