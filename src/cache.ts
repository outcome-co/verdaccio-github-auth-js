import NodeCache from 'node-cache'

export default class Cache {
    cache: NodeCache

    constructor() {
        this.cache = new NodeCache({
            stdTTL: 300, // 5 minutes
            useClones: false
        })
    }

    get<T>(key: string, fn: () => T): T {
        let value = this.cache.get<T>(key)
        if (value === undefined) {
            value = fn()
            this.cache.set(key, value)
        }
        return value
    }
}
