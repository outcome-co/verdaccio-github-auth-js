import NodeCache from 'node-cache'

export default class Cache {
    constructor () {
        this.cache = new NodeCache({
            stdTTL: 300, // 5 minutes
            useClones: false
        })
    }

    get (key, fn) {
        let value
        value = this.cache.get(key)
        if (value === undefined) {
            value = fn()
            this.cache.set(key, value)
        }
        return value
    }
}
