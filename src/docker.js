import Docker from "dockerode";
import config from "./config.js";

const docker = new Docker({ socketPath: config.dockerSocket });

import fs from "fs/promises";

/**
 * Pull a Docker image only if missing
 */
export async function pullImage(image) {
    try {
        const imageInfo = await docker.getImage(image).inspect();
        if (imageInfo) {
            console.log(`[Docker] Image ${image} already exists locally. Skipping pull.`);
            return;
        }
    } catch (e) {
        // Image not found, proceed to pull
    }

    console.log(`[Docker] Pulling image: ${image}`);
    return new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (err) => {
                if (err) return reject(err);
                console.log(`[Docker] Image pulled: ${image}`);
                resolve();
            });
        });
    });
}

/**
 * Create and start a game server container
 */
export async function createServer({ serverId, image, env, limits, ports }) {
    const containerName = `${config.containerPrefix}${serverId.substring(0, 12)}`;
    const dataPath = `${config.dataDir}/${serverId}`;

    // Ensure directory exists with proper permissions
    await fs.mkdir(dataPath, { recursive: true }).catch(() => { });

    // Pull image first
    await pullImage(image);

    // Build env array
    const envArray = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);

    // Build port bindings
    const exposedPorts = {};
    const portBindings = {};
    if (ports && ports.length > 0) {
        ports.forEach((p) => {
            exposedPorts[`${p.container}/${p.protocol || "tcp"}`] = {};
            portBindings[`${p.container}/${p.protocol || "tcp"}`] = [
                { HostIp: "0.0.0.0", HostPort: String(p.host) },
            ];
        });
    } else {
        // Default Minecraft port
        exposedPorts["25565/tcp"] = {};
    }

    const container = await docker.createContainer({
        name: containerName,
        Image: image,
        Env: envArray,
        ExposedPorts: exposedPorts,
        Tty: true,
        OpenStdin: true,
        HostConfig: {
            Memory: (limits?.memory || 1024) * 1024 * 1024, // MB → bytes
            NanoCpus: Math.floor((limits?.cpu || 100) * 1e7), // % → nanocpus
            DiskQuota: (limits?.disk || 10240) * 1024 * 1024, // MB → bytes
            Binds: [`${dataPath}:/data`],
            PortBindings: portBindings,
            RestartPolicy: { Name: "unless-stopped" },
            NetworkMode: "bridge",
        },
        Labels: {
            "ghosting.server_id": serverId,
            "ghosting.managed": "true",
        },
    });

    await container.start();
    console.log(`[Docker] Container started: ${containerName} (${container.id})`);

    return {
        containerId: container.id,
        containerName,
    };
}

/**
 * Power control: start, stop, restart, kill
 */
export async function powerAction(dockerId, action) {
    const container = docker.getContainer(dockerId);

    switch (action) {
        case "start":
            await container.start();
            break;
        case "stop":
            // Attempt graceful stop if it's a game server (MC)
            try {
                await writeToContainer(dockerId, "stop");
            } catch (err) {
                console.warn("[Docker] Failed to send stop command to stdin, falling back to SIGTERM:", err.message);
            }
            await container.stop({ t: 20 });
            break;
        case "restart":
            // Attempt graceful restart (stop command + start)
            try {
                await writeToContainer(dockerId, "stop");
            } catch (err) {
                console.warn("[Docker] Failed to send stop command for restart:", err.message);
            }
            await container.restart({ t: 20 });
            break;
        case "kill":
            await container.kill();
            break;
        default:
            throw new Error(`Unknown power action: ${action}`);
    }

    console.log(`[Docker] Power ${action} executed`);
}

/**
 * Delete a container and its data
 */
export async function deleteServer(dockerId) {
    const container = docker.getContainer(dockerId);
    let serverId = null;

    try {
        const info = await container.inspect();
        serverId = info.Config.Labels["ghosting.server_id"];
        await container.stop({ t: 5 }).catch(() => { });
    } catch { }

    try {
        await container.remove({ force: true, v: true });
        console.log(`[Docker] Container removed: ${dockerId}`);
    } catch (e) {
        console.error(`[Docker] Failed to remove container ${dockerId}:`, e.message);
    }

    if (serverId) {
        const dataPath = `${config.dataDir}/${serverId}`;
        try {
            await fs.rm(dataPath, { recursive: true, force: true });
            console.log(`[Docker] Data directory removed: ${dataPath}`);
        } catch (e) {
            console.error(`[Docker] Failed to remove data directory ${dataPath}:`, e.message);
        }
    }
}

/**
 * Execute a command inside a container
 */
export async function execCommand(dockerId, command) {
    const container = docker.getContainer(dockerId);
    const exec = await container.exec({
        Cmd: ["sh", "-c", command],
        AttachStdout: true,
        AttachStderr: true,
    });

    const stream = await exec.start();
    let output = "";

    return new Promise((resolve) => {
        stream.on("data", (chunk) => {
            output += chunk.toString();
        });
        stream.on("end", () => {
            resolve(output.trim());
        });
        // Timeout after 10s
        setTimeout(() => resolve(output.trim()), 10000);
    });
}

/**
 * Write a command directly to a container's stdin (for game server commands)
 */
export async function writeToContainer(dockerId, command) {
    const container = docker.getContainer(dockerId);
    const stream = await container.attach({
        stream: true,
        stdin: true,
        stdout: false,
        stderr: false,
    });

    // Most game servers expect a newline at the end of the command
    stream.write(command + "\n");
}

/**
 * Get container stats (CPU, memory, network)
 */
export async function getContainerStats(dockerId) {
    const container = docker.getContainer(dockerId);
    const stats = await container.stats({ stream: false });

    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuPercent = sysDelta > 0
        ? (cpuDelta / sysDelta) * (stats.cpu_stats.online_cpus || 1) * 100
        : 0;

    const memUsed = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 0;

    const info = await container.inspect();
    const serverId = info.Config.Labels["ghosting.server_id"];

    // Add missing files import if not present
    const { getDirectorySize } = await import("./files.js");
    const diskBytes = serverId ? await getDirectorySize(`${config.dataDir}/${serverId}`) : 0;

    return {
        cpu: Math.round(cpuPercent * 100) / 100,
        memory: Math.round(memUsed / 1024 / 1024), // MB
        memoryLimit: Math.round(memLimit / 1024 / 1024), // MB
        memoryPercent: memLimit > 0 ? Math.round((memUsed / memLimit) * 10000) / 100 : 0,
        disk: Math.round(diskBytes / 1024 / 1024), // Add this in MB
        network: {
            rx: Object.values(stats.networks || {}).reduce((a, n) => a + n.rx_bytes, 0),
            tx: Object.values(stats.networks || {}).reduce((a, n) => a + n.tx_bytes, 0),
        },
    };
}

/**
 * List all managed containers
 */
export async function listManagedContainers() {
    const containers = await docker.listContainers({
        all: true,
        filters: { label: ["ghosting.managed=true"] },
    });
    return containers;
}

/**
 * Stream container logs (follow mode)
 */
export function streamLogs(dockerId, onLine, options = {}) {
    const container = docker.getContainer(dockerId);
    const tail = options.tail || 200;

    container.logs(
        { follow: true, stdout: true, stderr: true, tail },
        (err, stream) => {
            if (err) {
                console.error(`[Docker] Log stream error for ${dockerId}:`, err);
                return;
            }

            stream.on("data", (chunk) => {
                // Docker uses an 8-byte header for multiplexing streams (stdout/stderr)
                // When parsing raw streams, we need to handle this correctly.
                // However, since we requested Tty: true in createServer, the header is not 8 bytes
                // The issue here is .replace(/^.{8}/, "") is blindly removing the first 8 characters
                // which causes the "opying", "reating", "isabling" issue.
                // Let's just convert it to string directly.
                const text = chunk.toString("utf8");
                if (text) onLine(text);
            });

            stream.on("error", () => { });
            stream.on("end", () => { });
        }
    );
}

export { docker };
export default docker;
