import { ClientSocket, ClientSocketOptions } from "@socket-mesh/client";
import { DrawChannelMap, DrawServiceMap } from '@socket-mesh/draw-models';
import env from "./env.js";

interface DrawClientMap {
	Channel: DrawChannelMap,
	Incoming: {},
	Service: {},
	Outgoing: DrawServiceMap,
	PrivateOutgoing: {},
	State: {}
}

const WS_PORT = 8000;

const clientOptions: ClientSocketOptions<DrawClientMap> = {
	address: `${env.address}:${WS_PORT}`,
	ackTimeoutMs: 200
}

const client = new ClientSocket(clientOptions);

const clearButton = document.getElementById('clearButton');
const canvasDiv = document.getElementsByClassName('canvas')[0];
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { willReadFrequently: true });
let resizeTimeout: NodeJS.Timeout;

console.log(canvasDiv.clientWidth);
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
			await client.invoke('draw', { x: e.clientX, y: e.clientY });
		} catch (err) {
			console.log('invoke error', err);
		}
	}
});

canvas.addEventListener('mousemove', async (e) => {
	if ((e.buttons & 1) === 1) {
		try {
			await client.invoke('draw', { x: e.clientX, y: e.clientY });
		} catch (err) {
			console.log('invoke error', err);
		}
	}
});

clearButton.addEventListener('click', async (e) => {
	try {
		client.channels.write('clear', {});
	} catch (err) {
		console.log('publish error', err);
	}
})