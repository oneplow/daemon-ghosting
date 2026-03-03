import http from "http";
import path from "path";
import fs from "fs";
import busboy from "busboy";
import { WebSocketServer } from "ws";
import config from "./config.js";
import { getConnectionStatus } from "./websocket.js";
import { getNodeMetrics, getServerMetrics } from "./metrics.js";
import { getActiveSessionCount } from "./console.js";
import { docker, createServer, powerAction, deleteServer, getContainerStats, listManagedContainers } from "./docker.js";
import { getDirectorySize, listFiles, readFile, writeFile, createFileOrDir, deleteFileOrDir, getSafePath } from "./files.js";
import { createBackup, listBackups, deleteBackup, restoreBackup } from "./backup.js";

/**
 * HTTP API Server
 * Handles direct requests from the central API (backup for WebSocket)
 */
export function startHTTPServer() {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Auth check - handled first
        const authHeader = req.headers.authorization;
        const urlToken = url.searchParams.get("token");

        if (authHeader !== `Bearer ${config.authToken}` && urlToken !== config.authToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "Unauthorized" }));
            return;
        }

        try {
            // ── Health ──────────────────────────
            if (pathname === "/api/health" && req.method === "GET") {
                const metrics = await getNodeMetrics();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    status: "ok",
                    daemon: config.daemonId,
                    nodeName: config.nodeName,
                    wsConnected: getConnectionStatus(),
                    activeSessions: getActiveSessionCount(),
                    ...metrics,
                }));
                return;
            }

            // ── Server power ───────────────────
            const powerMatch = pathname.match(/^\/api\/servers\/(.+)\/power$/);
            if (powerMatch && req.method === "POST") {
                const body = await readBody(req);
                const { action, diskLimit } = JSON.parse(body);
                const containerId = powerMatch[1];

                // Enforce desk storage limit before starting
                if (action === "start" && diskLimit) {
                    try {
                        const container = docker.getContainer(containerId);
                        const info = await container.inspect();
                        const serverId = info.Config.Labels["ghosting.server_id"];

                        if (serverId) {
                            const dataPath = path.resolve(config.dataDir, serverId);
                            const currentSize = await getDirectorySize(dataPath);
                            const limitBytes = diskLimit * 1024 * 1024;

                            if (currentSize > limitBytes) {
                                res.writeHead(403, { "Content-Type": "application/json" });
                                res.end(JSON.stringify({
                                    message: `Storage limit exceeded. Used: ${(currentSize / 1024 / 1024).toFixed(2)} MB, Limit: ${diskLimit} MB. Please upgrade your plan or delete some files.`
                                }));
                                return;
                            }
                        }
                    } catch (err) {
                        console.error("[HTTP] Error checking disk limit before start:", err.message);
                        // Continue to start if we can't verify (fallback)
                    }
                }

                await powerAction(containerId, action);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true }));
                return;
            }

            // ── Server stats ───────────────────
            const statsMatch = pathname.match(/^\/api\/servers\/(.+)\/stats$/);
            if (statsMatch && req.method === "GET") {
                const stats = await getContainerStats(statsMatch[1]);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(stats));
                return;
            }

            // ── List/Create containers ────────────────
            if (pathname === "/api/servers") {
                if (req.method === "GET") {
                    const containers = await listManagedContainers();
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ containers }));
                    return;
                }

                if (req.method === "POST") {
                    const body = await readBody(req);
                    const { serverId, image, env, limits, ports } = JSON.parse(body);

                    try {
                        const result = await createServer({ serverId, image, env, limits, ports });
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(result));
                    } catch (e) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ message: "Failed to create container: " + e.message }));
                    }
                    return;
                }
            }

            // ── Delete container ────────────────
            const deleteMatch = pathname.match(/^\/api\/servers\/(.+)$/);
            if (deleteMatch && req.method === "DELETE") {
                const dockerId = deleteMatch[1];
                try {
                    await deleteServer(dockerId);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "Failed to delete container: " + e.message }));
                }
                return;
            }

            // ── Servers metrics ────────────────
            if (pathname === "/api/metrics" && req.method === "GET") {
                const serverMetrics = await getServerMetrics();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ metrics: serverMetrics }));
                return;
            }

            // ── Files ──────────────────────────
            const filesMatch = pathname.match(/^\/api\/servers\/(.+)\/files$/);
            if (filesMatch) {
                const serverId = filesMatch[1];
                const reqPath = url.searchParams.get("path") || "/";

                if (req.method === "GET") {
                    const files = await listFiles(serverId, reqPath);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(files));
                    return;
                }

                if (req.method === "POST") {
                    const body = await readBody(req);
                    const { isDir } = JSON.parse(body);
                    await createFileOrDir(serverId, reqPath, isDir);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }

                if (req.method === "DELETE") {
                    await deleteFileOrDir(serverId, reqPath);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }
            }

            const fileContentMatch = pathname.match(/^\/api\/servers\/(.+)\/files\/content$/);
            if (fileContentMatch) {
                const serverId = fileContentMatch[1];
                const reqPath = url.searchParams.get("path") || "/";

                try {
                    if (req.method === "GET") {
                        const content = await readFile(serverId, reqPath);
                        res.writeHead(200, { "Content-Type": "text/plain" });
                        res.end(content);
                        return;
                    }

                    if (req.method === "PUT") {
                        const body = await readBody(req);
                        const { content } = JSON.parse(body);
                        await writeFile(serverId, reqPath, content);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true }));
                        return;
                    }
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: "File error: " + e.message }));
                    return;
                }
            }

            // ── File Download ────────────────────
            const downloadMatch = pathname.match(/^\/api\/servers\/(.+)\/files\/download$/);
            if (downloadMatch && req.method === "GET") {
                const serverId = downloadMatch[1];
                const reqPath = url.searchParams.get("path") || "/";
                try {
                    const { targetPath } = getSafePath(serverId, reqPath);
                    const stat = fs.statSync(targetPath);
                    if (!stat.isFile()) throw new Error("Not a file");

                    res.writeHead(200, {
                        "Content-Type": "application/octet-stream",
                        "Content-Length": stat.size,
                        "Content-Disposition": `attachment; filename="${path.basename(targetPath)}"`
                    });
                    const fileStream = fs.createReadStream(targetPath);
                    fileStream.pipe(res);
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: e.message }));
                }
                return;
            }

            // ── File Upload ──────────────────────
            const uploadMatch = pathname.match(/^\/api\/servers\/(.+)\/files\/upload$/);
            if (uploadMatch && req.method === "POST") {
                const serverId = uploadMatch[1];
                const reqPath = url.searchParams.get("path") || "/";

                try {
                    const { targetPath } = getSafePath(serverId, reqPath);
                    const bb = busboy({ headers: req.headers });
                    let savedCount = 0;

                    bb.on("file", (name, file, info) => {
                        const { filename } = info;
                        const saveTo = path.join(targetPath, filename);
                        file.pipe(fs.createWriteStream(saveTo));
                        file.on("end", () => {
                            savedCount++;
                        });
                    });

                    bb.on("finish", () => {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true, count: savedCount }));
                    });

                    bb.on("error", (err) => {
                        if (!res.headersSent) {
                            res.writeHead(500, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ message: err.message }));
                        }
                    });

                    req.pipe(bb);
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: e.message }));
                }
                return;
            }

            // ── Backups ────────────────────────────
            const backupsMatch = pathname.match(/^\/api\/servers\/(.+)\/backups\/?(.*)$/);
            if (backupsMatch) {
                const serverId = backupsMatch[1];
                const actionParam = backupsMatch[2]; // e.g. "", "xyz.tar.gz", "xyz.tar.gz/restore"

                try {
                    if (req.method === "GET" && !actionParam) {
                        const backups = await listBackups(serverId);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(backups));
                        return;
                    }

                    if (req.method === "POST" && !actionParam) {
                        let bodyName = "backup";
                        try {
                            const body = await readBody(req);
                            if (body && body.trim() !== "") {
                                const parsed = JSON.parse(body);
                                if (parsed.name) bodyName = parsed.name;
                            }
                        } catch (e) { }

                        const backupInfo = await createBackup(serverId, bodyName);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(backupInfo));
                        return;
                    }

                    if (req.method === "DELETE" && actionParam) {
                        await deleteBackup(serverId, actionParam);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true }));
                        return;
                    }

                    if (req.method === "POST" && actionParam.endsWith("/restore")) {
                        const filename = actionParam.replace("/restore", "");
                        await restoreBackup(serverId, filename);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ success: true }));
                        return;
                    }
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ message: e.message }));
                    return;
                }
            }

            // ── 404 ────────────────────────────
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "Not found" }));
        } catch (err) {
            console.error("[HTTP] Error:", err.message);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: err.message }));
        }
    });

    // Handle WebSocket Upgrades
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);

        // Match /api/servers/:id/console
        const consoleMatch = url.pathname.match(/^\/api\/servers\/(.+)\/console$/);

        if (consoleMatch) {
            // Verify Auth via query parameter or header for WebSocket
            const token = url.searchParams.get("token") || request.headers["x-auth-token"];
            if (token !== config.authToken) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }

            const containerId = consoleMatch[1];

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit("connection", ws, request, containerId);
            });
        } else {
            socket.destroy();
        }
    });

    wss.on("connection", async (ws, request, containerId) => {
        try {
            const container = docker.getContainer(containerId);
            const info = await container.inspect();
            const serverId = info.Config.Labels["ghosting.server_id"];
            const isTty = info.Config.Tty;

            if (!serverId) throw new Error("Not a managed server");

            // Attach to stream logs
            const stream = await container.logs({
                follow: true,
                stdout: true,
                stderr: true,
                tail: 100
            });

            // Send data to client
            stream.on("data", (chunk) => {
                let text;
                if (isTty) {
                    // TTY mode: no multiplex headers, raw text
                    text = chunk.toString("utf8");
                } else {
                    // Non-TTY: Docker prepends 8-byte multiplex header per frame
                    text = "";
                    let offset = 0;
                    while (offset < chunk.length) {
                        if (chunk.length - offset >= 8 &&
                            (chunk[offset] === 1 || chunk[offset] === 2) &&
                            chunk[offset + 1] === 0 &&
                            chunk[offset + 2] === 0 &&
                            chunk[offset + 3] === 0) {
                            const size = chunk.readUInt32BE(offset + 4);
                            if (size > 0 && offset + 8 + size <= chunk.length) {
                                text += chunk.toString("utf8", offset + 8, offset + 8 + size);
                                offset += 8 + size;
                                continue;
                            }
                        }
                        text += chunk.toString("utf8", offset);
                        break;
                    }
                }

                if (text) {
                    // Filter out [Server process ended] with potential ANSI codes
                    const filteredText = text.replace(/(\x1B\[[0-9;]*[JKmsu])?\[Server process ended\](\x1B\[[0-9;]*[JKmsu])?/g, "");
                    if (filteredText && ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ event: "output", data: filteredText }));
                    }
                }
            });

            stream.on("end", () => {
                if (ws.readyState === ws.OPEN) {
                    ws.close(1000, "stream ended");
                }
            });

            // Receive commands from client
            ws.on("message", async (msg) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.event === "input" && data.command) {
                        const { writeToStdin } = await import("./console.js");
                        await writeToStdin(containerId, data.command);
                    }
                } catch (e) {
                    console.error("[WS] Parse error:", e);
                }
            });

            ws.on("close", () => {
                stream.destroy();
            });

            ws.on("error", (err) => {
                console.error("[WS] Client error:", err.message);
                stream.destroy();
            });

        } catch (err) {
            console.error("[WS] Connection error:", err.message);
            ws.send(JSON.stringify({ event: "error", data: err.message }));
            ws.close();
        }
    });

    server.listen(config.httpPort, config.httpHost, () => {
        console.log(`[HTTP] Server listening on ${config.httpHost}:${config.httpPort}`);
    });

    return server;
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
    });
}
