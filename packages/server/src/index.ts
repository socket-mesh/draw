import { RequestHandlerArgs } from '@socket-mesh/core';
import { BasicServerMap, listen } from '@socket-mesh/server';
import { DrawChannelMap, DrawServiceMap, Point } from '@socket-mesh/draw-models';
import express from 'express';
import path from 'path';

const app = express();
const port = 3000;
const WS_PORT = 8000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const server = listen<BasicServerMap<DrawServiceMap, DrawChannelMap>>(
	WS_PORT,
	{
		handlers: {
			draw: async ({ options }: RequestHandlerArgs<Point>) => {
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