export type Draw = {
	id: string,
	x: number,
	y: number,
	timestamp: number
}

export type DrawChannelMap = {
	draw: Draw,
	clear: {}
}

export type DrawServiceMap = {
	clear: () => void,
	draw: (options: Draw) => void
}