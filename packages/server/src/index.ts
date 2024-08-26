import { RequestHandlerArgs } from '@socket-mesh/core';
import { BasicServerMap, listen } from '@socket-mesh/server';
import { DrawChannelMap, DrawServiceMap, Draw } from '@socket-mesh/draw-models';
import express from 'express';
import path from 'path';

// ---------------- Express ----------------
const app = express();
const port = 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// -------------- Socket Mesh --------------
const WS_PORT = 8000;

const server = listen<BasicServerMap<DrawServiceMap, DrawChannelMap>>(
	WS_PORT,
	{
		handlers: {
			draw: async ({ options }: RequestHandlerArgs<Draw>) => {
				await server.exchange.transmitPublish('draw', options);
			},
			clear: async () => {
				await server.exchange.transmitPublish('clear', {});
			}
		}
	});

(async () =>  {
	for await (const e of server.listen('connection')) {
		console.log('connected');
	}
})();

(async () =>  {
	for await (const e of server.listen('socketClose')) {
		console.log('disconnected');
	}
})();