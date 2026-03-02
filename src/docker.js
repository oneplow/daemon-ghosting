import Docker from "dockerode";
import config from "./config.js";

const docker = new Docker({ socketPath: config.dockerSocket });

/**
 * Pull a Docker image
 */
export async function pullImage(image) {
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
            await container.stop({ t: 15 });
            break;
        case "restart":
            await container.restart({ t: 15 });
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
 * Delete a container
 */
export async function deleteServer(dockerId) {
    const container = docker.getContainer(dockerId);
    try {
        await container.stop({ t: 5 }).catch(() => { });
    } catch { }
    await container.remove({ force: true, v: true });
    console.log(`[Docker] Container removed: ${dockerId}`);
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

    return {
        cpu: Math.round(cpuPercent * 100) / 100,
        memory: Math.round(memUsed / 1024 / 1024), // MB
        memoryLimit: Math.round(memLimit / 1024 / 1024), // MB
        memoryPercent: memLimit > 0 ? Math.round((memUsed / memLimit) * 10000) / 100 : 0,
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
                // Remove Docker header (8 bytes) from each frame
                const line = chunk.toString().replace(/^.{8}/, "").trim();
                if (line) onLine(line);
            });

            stream.on("error", () => { });
            stream.on("end", () => { });
        }
    );
}

export { docker };
export default docker;
