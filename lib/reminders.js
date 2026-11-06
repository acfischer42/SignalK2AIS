'use strict'

const WEBAPP = '/signalk-write-ais-nmea0183/'
const PATH = 'notifications.aisVoyage.checklist'

class Reminders {
  constructor(publish, delay, schedule = setTimeout, cancel = clearTimeout) {
    this.publish = publish
    this.delay = delay
    this.schedule = schedule
    this.cancel = cancel
    this.baseline = null
    this.pending = null
    this.timer = null
    this.active = null
  }

  observe(status) {
    const group = [0, 8].includes(status) ? 'moving' : [1, 5].includes(status) ? 'stopped' : null
    if (!group || group === this.baseline) {
      this.cancelPending()
      return
    }
    if (this.baseline === null) {
      this.baseline = group
      return
    }
    if (group === this.pending) return
    this.cancelPending()
    this.pending = group
    this.timer = this.schedule(() => {
      this.timer = null
      this.pending = null
      this.baseline = group
      const departure = group === 'moving'
      const value = {
        state: 'alert',
        method: ['visual'],
        message: `${departure ? 'Departing: check AIS destination, ETA and persons aboard.' : 'Arrived: review AIS voyage data and navigational status.'} Open SignalK2AIS: ${WEBAPP}`,
        // Optional extension: clients without link support still display the address.
        href: WEBAPP
      }
      if (this.publish(PATH, value) !== false) this.active = value
    }, this.delay)
  }

  cancelPending() {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
    this.pending = null
  }

  clear() {
    if (this.publish(PATH, null) === false) return false
    this.active = null
    return true
  }

  stop() {
    this.cancelPending()
    if (this.active) this.clear()
  }
}

module.exports = { Reminders }
