import { ClientSocket, ClientSocketOptions } from "@socket-mesh/client";
import { DrawChannelMap, DrawServiceMap } from '@socket-mesh/draw-models';
import env from "./env.js";

declare const DEBUG: boolean;

const clientOptions: ClientSocketOptions<DrawServiceMap> = {
	address: `${env.address}:${env.port}`,
	ackTimeoutMs: 200
}

const client = new ClientSocket<DrawServiceMap, DrawChannelMap>(clientOptions);

const clearButton = document.getElementById('clearButton');
const canvasDiv = document.getElementsByClassName('canvas')[0];
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { willReadFrequently: true });
let resizeTimeout: NodeJS.Timeout;

canvas.width  = canvasDiv.clientWidth;
canvas.height = canvasDiv.clientHeight;

(async () =>  {
	for await (const e of client.listen('error')) {
		console.log('error', e);
	}
})();

(async () =>  {
	for await (const e of client.listen('connect')) {
		console.log('connected', e.id);
	}
})();

(async () =>  {
	for await (const e of client.listen('disconnect')) {
		console.log('disconnected', e.reason);
	}
})();

(async () =>  {
	for await (const e of client.channels.subscribe('draw')) {
		ctx.fillRect(e.x, e.y, 2, 2);

		if (e.id === client.id) {
			console.log(`Ping ${new Date().valueOf() - e.timestamp}`);
		}
	}
})();

(async () =>  {
	for await (const e of client.channels.subscribe('clear')) {
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = "black";
	}
})();

window.addEventListener('resize', (e) => {
	if (resizeTimeout) {
		clearTimeout(resizeTimeout);
	}

	resizeTimeout = setTimeout(() => {
		const data = ctx.getImageData(0, 0, canvas.width, canvas.height);

		canvas.style.width = `${canvasDiv.clientWidth}px`;
		canvas.style.height = `${canvasDiv.clientHeight}px`;
		canvas.width  = canvasDiv.clientWidth;
		canvas.height = canvasDiv.clientHeight;
	
		ctx.putImageData(data, 0, 0);
		resizeTimeout = null;
	}, 100);
});

canvas.addEventListener('mousedown', async (e) => {
	if ((e.buttons & 1) === 1) {
		try {
			await client.invoke('draw', { id: client.id, x: e.clientX, y: e.clientY, timestamp: new Date().valueOf() });
		} catch (err) {
			console.log('invoke error', err);
		}
	}
});

canvas.addEventListener('mousemove', async (e) => {
	if ((e.buttons & 1) === 1) {
		try {
			await client.invoke('draw', { id: client.id, x: e.clientX, y: e.clientY, timestamp: new Date().valueOf() });
		} catch (err) {
			console.log('invoke error', err);
		}
	}
});

clearButton.addEventListener('click', async (e) => {
	try {
		client.channels.invokePublish('clear', {});
	} catch (err) {
		console.log('publish error', err);
	}
})