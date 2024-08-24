export type Point = {
	x: number,
	y: number
}

export type DrawChannelMap = {
	draw: Point,
	clear: {}
}

export type DrawServiceMap = {
	clear: () => void,
	draw: (point: Point) => void
}