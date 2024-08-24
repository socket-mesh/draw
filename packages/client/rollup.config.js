import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

/** @type {import('rollup').RollupOptions} */
export default {
	input: 'src/index.ts',
	output: {
		file: '../../dist/public/index.js',
		format: 'es',
		paths: {
			'@socket-mesh/client': './socket-mesh-client.js'
		}
	},
	external: [
		'@socket-mesh/client'
	],
	plugins: [
		typescript({
			tsconfig: './tsconfig.build.json',
			outDir: '../../'
		}),
		nodeResolve({
			browser: true
		}),
		//terser()
	]
};