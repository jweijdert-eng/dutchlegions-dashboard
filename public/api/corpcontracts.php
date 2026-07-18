<?php
/**
 * Corp-contracten — open item-exchange-contracten van de corp, met Jita-waardering.
 *
 * Waarom server-side: het ESI-endpoint voor corp-contracten vereist de rol
 * Director/Accountant. Eén director koppelt hier eenmalig zijn token; daarna
 * kan ELK lid de contracten zien zonder zelf rechten te hebben.
 *
 *   GET  ?action=list    → de contracten + waardering (iedereen)
 *   GET  ?action=status  → is er een token gekoppeld, hoe vers is de data
 *   POST  action=link    → director koppelt zijn refresh-token (admin)
 *   POST  action=unlink  → koppeling weghalen (admin)
 */

require_once 'config.php';
cors();

// EVE SSO-app van het dashboard. Publieke waarde (PKCE-flow, geen client secret):
// nodig om het opgeslagen refresh-token in te wisselen voor een access-token.
if (!defined('EVE_CLIENT_ID')) define('EVE_CLIENT_ID', '59f38627d74f4ec7a0c8fd44e8b1a3b3');

/** Admin-check op basis van een geverifieerd EVE-token (character-ID's zijn spoofbaar). */
function ccRequireAdmin(array $body): int {
    $cid = eveVerify((string)($body['token'] ?? ''));
    if (!$cid || !isAdminRole($cid)) {
        http_response_code(403);
        echo json_encode(['error' => 'forbidden']);
        exit;
    }
    return $cid;
}

const CC_CACHE_SECONDS   = 900;   // contractenlijst 15 min vasthouden
const CC_PRICE_SECONDS   = 3600;  // marktprijzen 1 uur
const CC_ITEMS_PER_CALL  = 40;    // max contract-inhouden per verzoek ophalen
const CC_TIME_BUDGET     = 15;    // en hoe dan ook niet langer dan dit (PHP-limiet)
const CC_JITA_4_4        = 60003760;
const CC_MIN_SELL_VOLUME = 20;    // minder aanbod = te dun om op te waarderen
const CC_MAX_SELL_RATIO  = 10;    // sell > 10x buy = vrijwel zeker een gekke order

// ---------------------------------------------------------------- schema

function ccSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_token (
        id TINYINT PRIMARY KEY,
        char_id BIGINT NOT NULL,
        char_name VARCHAR(100) NOT NULL DEFAULT '',
        corp_id BIGINT NULL,
        corp_name VARCHAR(100) NOT NULL DEFAULT '',
        refresh_token TEXT NOT NULL,
        updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_items (
        contract_id BIGINT PRIMARY KEY,
        items LONGTEXT NOT NULL,
        fetched_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_prices (
        type_id INT PRIMARY KEY,
        name VARCHAR(150) NOT NULL DEFAULT '',
        buy DOUBLE NOT NULL DEFAULT 0,
        sell DOUBLE NOT NULL DEFAULT 0,
        sell_safe DOUBLE NOT NULL DEFAULT 0,
        thin TINYINT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cc_cache (
        k VARCHAR(64) PRIMARY KEY,
        v LONGTEXT NOT NULL,
        updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}

function ccCacheGet(PDO $pdo, string $key, int $maxAge): ?array {
    $st = $pdo->prepare('SELECT v, UNIX_TIMESTAMP(updated_at) AS ts FROM cc_cache WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    if ($maxAge > 0 && (time() - (int)$row['ts']) > $maxAge) return null;
    $data = json_decode($row['v'], true);
    return is_array($data) ? ['data' => $data, 'ts' => (int)$row['ts']] : null;
}

function ccCacheSet(PDO $pdo, string $key, array $value): void {
    $st = $pdo->prepare('INSERT INTO cc_cache (k, v, updated_at) VALUES (?, ?, NOW())
                         ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = NOW()');
    $st->execute([$key, json_encode($value)]);
}

// ---------------------------------------------------------------- http

function ccHttp(string $url, array $headers = [], ?string $post = null): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => array_merge(['User-Agent: dutchlegions-dashboard (corp-contracts)'], $headers),
    ]);
    if ($post !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $post);
    }
    $body   = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, $body === false ? '' : $body];
}

/** Wissel het opgeslagen refresh-token in voor een vers access-token (PKCE: geen secret nodig). */
function ccAccessToken(PDO $pdo, array &$row): ?string {
    [$status, $body] = ccHttp(
        'https://login.eveonline.com/v2/oauth/token',
        ['Content-Type: application/x-www-form-urlencoded', 'Host: login.eveonline.com'],
        http_build_query([
            'grant_type'    => 'refresh_token',
            'refresh_token' => $row['refresh_token'],
            'client_id'     => EVE_CLIENT_ID,
        ])
    );
    if ($status !== 200) return null;

    $data = json_decode($body, true);
    if (!isset($data['access_token'])) return null;

    // EVE geeft bij elke refresh een NIEUW refresh-token terug; het oude vervalt.
    if (!empty($data['refresh_token']) && $data['refresh_token'] !== $row['refresh_token']) {
        $st = $pdo->prepare('UPDATE cc_token SET refresh_token = ?, updated_at = NOW() WHERE id = 1');
        $st->execute([$data['refresh_token']]);
        $row['refresh_token'] = $data['refresh_token'];
    }
    return $data['access_token'];
}

function ccEsi(string $path, string $token): array {
    $sep = strpos($path, '?') === false ? '?' : '&';
    [$status, $body] = ccHttp(
        "https://esi.evetech.net/latest{$path}{$sep}datasource=tranquility",
        ['Authorization: Bearer ' . $token]
    );
    if ($status !== 200) return [false, null];
    $data = json_decode($body, true);
    return [true, is_array($data) ? $data : null];
}

// ---------------------------------------------------------------- prijzen

/** Jita-prijzen bijwerken voor de opgegeven types (Fuzzwork-aggregaten, batches van 200). */
function ccUpdatePrices(PDO $pdo, array $typeIds): void {
    if (!$typeIds) return;

    // Welke types hebben we nog niet, of zijn verouderd?
    $vers = [];
    $in = implode(',', array_fill(0, count($typeIds), '?'));
    $st = $pdo->prepare("SELECT type_id FROM cc_prices
                         WHERE type_id IN ($in) AND updated_at > DATE_SUB(NOW(), INTERVAL " . CC_PRICE_SECONDS . " SECOND)");
    $st->execute($typeIds);
    foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $t) $vers[(int)$t] = true;

    $todo = array_values(array_filter($typeIds, fn($t) => !isset($vers[(int)$t])));
    if (!$todo) return;

    $ins = $pdo->prepare('INSERT INTO cc_prices (type_id, name, buy, sell, sell_safe, thin, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, NOW())
                          ON DUPLICATE KEY UPDATE buy = VALUES(buy), sell = VALUES(sell),
                              sell_safe = VALUES(sell_safe), thin = VALUES(thin), updated_at = NOW()');

    foreach (array_chunk($todo, 200) as $chunk) {
        [$status, $body] = ccHttp('https://market.fuzzwork.co.uk/aggregates/?station=' . CC_JITA_4_4
                                  . '&types=' . implode(',', $chunk));
        if ($status !== 200) continue;
        $data = json_decode($body, true);
        if (!is_array($data)) continue;

        foreach ($data as $typeId => $row) {
            $buy        = (float)($row['buy']['percentile'] ?? 0);
            $sell       = (float)($row['sell']['percentile'] ?? 0);
            $sellVolume = (float)($row['sell']['volume'] ?? 0);

            // Eén gekke order kan een waardering compleet verzieken. De biedprijs
            // is het beste ijkpunt: ligt de vraagprijs daar absurd ver boven, dan
            // klopt-ie niet. Is er geen bod, dan eisen we op z'n minst wat diepte.
            $thin = $buy > 0
                ? ($sell > 0 && $sell > $buy * CC_MAX_SELL_RATIO)
                : ($sell > 0 && $sellVolume < CC_MIN_SELL_VOLUME);
            $sellSafe = ($thin && $buy > 0) ? $buy : $sell;

            $ins->execute([(int)$typeId, '', $buy, $sell, $sellSafe, $thin ? 1 : 0]);
        }
    }
}

/** Ontbrekende typenamen aanvullen via ESI (/universe/names). */
function ccUpdateNames(PDO $pdo, array $typeIds): void {
    if (!$typeIds) return;
    $in = implode(',', array_fill(0, count($typeIds), '?'));
    $st = $pdo->prepare("SELECT type_id FROM cc_prices WHERE type_id IN ($in) AND name = ''");
    $st->execute($typeIds);
    $todo = array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
    if (!$todo) return;

    $upd = $pdo->prepare('UPDATE cc_prices SET name = ? WHERE type_id = ?');
    foreach (array_chunk($todo, 500) as $chunk) {
        [$status, $body] = ccHttp(
            'https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
            ['Content-Type: application/json'],
            json_encode(array_values($chunk))
        );
        if ($status !== 200) continue;
        foreach ((json_decode($body, true) ?: []) as $row) {
            if (isset($row['id'], $row['name'])) $upd->execute([$row['name'], (int)$row['id']]);
        }
    }
}

// ---------------------------------------------------------------- opbouw

/** Alles ophalen/bijwerken en de klaargerekende regels teruggeven. */
function ccBuild(PDO $pdo): array {
    $st = $pdo->query('SELECT * FROM cc_token WHERE id = 1');
    $tok = $st->fetch(PDO::FETCH_ASSOC);
    if (!$tok) return ['ok' => false, 'error' => 'no_token'];

    $access = ccAccessToken($pdo, $tok);
    if (!$access) return ['ok' => false, 'error' => 'token_invalid'];

    $corpId = (int)$tok['corp_id'];
    if (!$corpId) {
        [$ok, $char] = ccEsi("/characters/{$tok['char_id']}/", $access);
        $corpId = $ok ? (int)($char['corporation_id'] ?? 0) : 0;
        if ($corpId) {
            $pdo->prepare('UPDATE cc_token SET corp_id = ? WHERE id = 1')->execute([$corpId]);
        }
    }
    if (!$corpId) return ['ok' => false, 'error' => 'no_corp'];

    // 1. Contracten (alle pagina's)
    $contracts = [];
    for ($page = 1; $page <= 20; $page++) {
        [$ok, $rows] = ccEsi("/corporations/{$corpId}/contracts/?page={$page}", $access);
        if (!$ok || !$rows) break;
        $contracts = array_merge($contracts, $rows);
        if (count($rows) < 1000) break;
    }
    if (!$contracts) return ['ok' => false, 'error' => 'no_contracts'];

    $open = array_values(array_filter($contracts, fn($c) =>
        ($c['type'] ?? '') === 'item_exchange' && ($c['status'] ?? '') === 'outstanding'));

    // 2. Inhoud per contract — ligt vast, dus we halen elk contract maar één keer op.
    $ids = array_map(fn($c) => (int)$c['contract_id'], $open);
    $have = [];
    if ($ids) {
        $in = implode(',', array_fill(0, count($ids), '?'));
        $st = $pdo->prepare("SELECT contract_id, items FROM cc_items WHERE contract_id IN ($in)");
        $st->execute($ids);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $have[(int)$r['contract_id']] = json_decode($r['items'], true) ?: [];
        }
    }

    $ins = $pdo->prepare('INSERT INTO cc_items (contract_id, items, fetched_at) VALUES (?, ?, NOW())
                          ON DUPLICATE KEY UPDATE items = VALUES(items), fetched_at = NOW()');
    $start = time();
    $opgehaald = 0;
    foreach ($ids as $cid) {
        if (isset($have[$cid])) continue;
        if ($opgehaald >= CC_ITEMS_PER_CALL || (time() - $start) > CC_TIME_BUDGET) break;
        [$ok, $items] = ccEsi("/corporations/{$corpId}/contracts/{$cid}/items/", $access);
        $opgehaald++;
        if (!$ok) continue;   // mislukt = onbekend; NIET als 'leeg' opslaan
        $items = $items ?: [];
        $ins->execute([$cid, json_encode($items)]);
        $have[$cid] = $items;
    }

    // 3. Prijzen + namen voor alles wat we nu kennen
    $typeIds = [];
    foreach ($have as $items) {
        foreach ($items as $i) if (!empty($i['type_id'])) $typeIds[(int)$i['type_id']] = true;
    }
    $typeIds = array_keys($typeIds);
    ccUpdatePrices($pdo, $typeIds);
    ccUpdateNames($pdo, $typeIds);

    $prices = [];
    if ($typeIds) {
        $in = implode(',', array_fill(0, count($typeIds), '?'));
        $st = $pdo->prepare("SELECT * FROM cc_prices WHERE type_id IN ($in)");
        $st->execute($typeIds);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $prices[(int)$r['type_id']] = $r;
    }

    // 4. Namen van de uitgevers
    $issuerIds = array_values(array_unique(array_map(fn($c) => (int)($c['issuer_id'] ?? 0), $open)));
    $issuerIds = array_values(array_filter($issuerIds));
    $namen = [];
    if ($issuerIds) {
        foreach (array_chunk($issuerIds, 500) as $chunk) {
            [$status, $body] = ccHttp(
                'https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
                ['Content-Type: application/json'], json_encode(array_values($chunk))
            );
            if ($status !== 200) continue;
            foreach ((json_decode($body, true) ?: []) as $r) $namen[(int)$r['id']] = $r['name'];
        }
    }
    $corpNaam = '';
    [$status, $body] = ccHttp('https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
                              ['Content-Type: application/json'], json_encode([$corpId]));
    if ($status === 200) {
        foreach ((json_decode($body, true) ?: []) as $r) if ((int)$r['id'] === $corpId) $corpNaam = $r['name'];
    }
    if ($corpNaam) $pdo->prepare('UPDATE cc_token SET corp_name = ? WHERE id = 1')->execute([$corpNaam]);

    // 5. Waarderen
    $rows = [];
    foreach ($open as $c) {
        $cid   = (int)$c['contract_id'];
        $prijs = (float)($c['price'] ?? 0);
        $beloning = (float)($c['reward'] ?? 0);
        $bekend = array_key_exists($cid, $have);
        $items  = $have[$cid] ?? [];

        $krijgt = []; $geeft = [];
        foreach ($items as $i) {
            if (!empty($i['is_included'])) $krijgt[] = $i;   // dit krijg je
            else                           $geeft[]  = $i;   // dit moet je inleveren
        }

        $waardeBuy = 0.0; $waardeSell = 0.0; $kostenItems = 0.0;
        $dun = false; $bpc = false; $prijsOnbekend = false;
        $regels = [];

        foreach ($krijgt as $i) {
            $tid = (int)($i['type_id'] ?? 0);
            $aantal = (int)($i['quantity'] ?? 0);
            $p = $prices[$tid] ?? null;
            $isBpc = !empty($i['is_blueprint_copy']) || (int)($i['raw_quantity'] ?? 0) === -2;
            if ($isBpc) $bpc = true;
            if ($p && !empty($p['thin'])) $dun = true;

            $buy  = $isBpc ? 0.0 : (float)($p['buy'] ?? 0);
            $sell = $isBpc ? 0.0 : (float)($p['sell_safe'] ?? 0);
            if (!$isBpc && !$sell) $prijsOnbekend = true;

            $waardeBuy  += $buy * $aantal;
            $waardeSell += $sell * $aantal;
            $regels[] = [
                'typeId' => $tid,
                'naam'   => $p['name'] ?? ('#' . $tid),
                'aantal' => $aantal,
                'isBpc'  => $isBpc,
                'waarde' => $sell * $aantal,
            ];
        }
        foreach ($geeft as $i) {
            $tid = (int)($i['type_id'] ?? 0);
            $p = $prices[$tid] ?? null;
            $kostenItems += (float)($p['sell_safe'] ?? 0) * (int)($i['quantity'] ?? 0);
        }

        usort($regels, fn($a, $b) => $b['waarde'] <=> $a['waarde']);

        $betaalt   = $prijs + $kostenItems;
        $nettoSell = $waardeSell + $beloning - $betaalt;
        $nettoBuy  = $waardeBuy  + $beloning - $betaalt;
        $marge     = $betaalt > 0 ? ($nettoSell / $betaalt * 100) : null;

        $rows[] = [
            'id'         => $cid,
            'titel'      => (string)($c['title'] ?? ''),
            'uitgever'   => $namen[(int)($c['issuer_id'] ?? 0)] ?? '',
            'prijs'      => $prijs,
            'beloning'   => $beloning,
            'betaalt'    => $betaalt,
            'waardeSell' => $bekend ? $waardeSell : null,
            'waardeBuy'  => $bekend ? $waardeBuy  : null,
            'nettoSell'  => $bekend ? $nettoSell  : null,
            'nettoBuy'   => $bekend ? $nettoBuy   : null,
            'marge'      => $bekend ? $marge      : null,
            'items'      => array_slice($regels, 0, 6),
            'aantalItems'=> count($regels),
            'onbekend'   => !$bekend,
            'leeg'       => $bekend && !$items,
            'dunneMarkt' => $dun,
            'heeftBpc'   => $bpc,
            'prijsOnbekend' => $prijsOnbekend,
            'verlooptOp' => (string)($c['date_expired'] ?? ''),
            'locatieId'  => (int)($c['start_location_id'] ?? 0),
        ];
    }

    usort($rows, function ($a, $b) {
        if ($a['onbekend'] !== $b['onbekend']) return $a['onbekend'] ? 1 : -1;
        return $b['nettoSell'] <=> $a['nettoSell'];
    });

    $bekendeRijen = array_values(array_filter($rows, fn($r) => !$r['onbekend']));
    return [
        'ok'      => true,
        'corp'    => ['id' => $corpId, 'naam' => $corpNaam ?: ('#' . $corpId)],
        'rows'    => $rows,
        'totalen' => [
            'aantal'      => count($rows),
            'onbekend'    => count($rows) - count($bekendeRijen),
            'koopjes'     => count(array_filter($bekendeRijen, fn($r) => $r['nettoSell'] > 0)),
            'waarde'      => array_sum(array_column($bekendeRijen, 'waardeSell')),
            'vraagprijs'  => array_sum(array_column($bekendeRijen, 'betaalt')),
            'netto'       => array_sum(array_column($bekendeRijen, 'nettoSell')),
            'beste'       => $bekendeRijen ? max(array_column($bekendeRijen, 'nettoSell')) : 0,
        ],
    ];
}

// ---------------------------------------------------------------- routes

$pdo = getDB();
ccSchema($pdo);
$action = $_GET['action'] ?? 'list';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true) ?: [];
    ccRequireAdmin($body);

    if (($body['action'] ?? '') === 'unlink') {
        $pdo->exec('DELETE FROM cc_token');
        echo json_encode(['ok' => true]);
        exit;
    }

    $refresh = trim((string)($body['refreshToken'] ?? ''));
    $charId  = (int)($body['charId'] ?? 0);
    $charNaam = (string)($body['charName'] ?? '');
    if ($refresh === '' || !$charId) {
        http_response_code(400); echo json_encode(['error' => 'refreshToken en charId vereist']); exit;
    }

    $st = $pdo->prepare('INSERT INTO cc_token (id, char_id, char_name, refresh_token, updated_at)
                         VALUES (1, ?, ?, ?, NOW())
                         ON DUPLICATE KEY UPDATE char_id = VALUES(char_id), char_name = VALUES(char_name),
                             refresh_token = VALUES(refresh_token), corp_id = NULL, updated_at = NOW()');
    $st->execute([$charId, $charNaam, $refresh]);

    // Meteen proberen: zo weet de director direct of z'n rechten volstaan.
    $result = ccBuild($pdo);
    if (empty($result['ok'])) {
        $pdo->exec('DELETE FROM cc_token');
        http_response_code(400);
        echo json_encode(['error' => $result['error'] ?? 'mislukt',
                          'hint'  => 'Heeft dit character de rol Director of Accountant?']);
        exit;
    }
    ccCacheSet($pdo, 'corp_contracts', $result);
    echo json_encode(['ok' => true, 'aantal' => $result['totalen']['aantal']]);
    exit;
}

if ($action === 'status') {
    $tok = $pdo->query('SELECT char_name, corp_name, updated_at FROM cc_token WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
    $cache = ccCacheGet($pdo, 'corp_contracts', 0);
    echo json_encode([
        'gekoppeld'  => (bool)$tok,
        'character'  => $tok['char_name'] ?? '',
        'corp'       => $tok['corp_name'] ?? '',
        'bijgewerkt' => $cache ? date('c', $cache['ts']) : null,
    ]);
    exit;
}

// action=list — uit de cache, en alleen ververen als die verlopen is
$force = !empty($_GET['refresh']);
$cache = $force ? null : ccCacheGet($pdo, 'corp_contracts', CC_CACHE_SECONDS);
if ($cache) {
    echo json_encode($cache['data'] + ['bijgewerkt' => date('c', $cache['ts']), 'uitCache' => true]);
    exit;
}

$result = ccBuild($pdo);
if (empty($result['ok'])) {
    // Liever verouderde data dan een lege pagina.
    $oud = ccCacheGet($pdo, 'corp_contracts', 0);
    if ($oud) {
        echo json_encode($oud['data'] + ['bijgewerkt' => date('c', $oud['ts']), 'verouderd' => true,
                                         'fout' => $result['error'] ?? '']);
        exit;
    }
    http_response_code(($result['error'] ?? '') === 'no_token' ? 404 : 500);
    echo json_encode(['error' => $result['error'] ?? 'mislukt']);
    exit;
}

ccCacheSet($pdo, 'corp_contracts', $result);
echo json_encode($result + ['bijgewerkt' => date('c'), 'uitCache' => false]);
