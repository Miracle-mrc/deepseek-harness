/** A Git version probe that stays pending until the caller's deadline stops it. */
if (process.argv.at(-1) !== '--version') throw new Error('Only the Git version probe may reach this fixture')
setInterval(() => {}, 1000)
