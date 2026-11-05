'use strict';
const Appointment = require('../models/Appointment');
const unavailable = require('../../utils/unavailableOperation');
function bookAppointment(payload) { return Appointment.create(payload); }
function confirmAppointment() { return unavailable('Appointment confirmation and delivery'); }
function completeAppointment() { return unavailable('Appointment completion'); }
module.exports = { bookAppointment, confirmAppointment, completeAppointment };
