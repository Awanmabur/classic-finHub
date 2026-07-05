const { appointments, createAppointment } = require('../../data/store');
function bookAppointment(payload) { return createAppointment(payload); }
function confirmAppointment(id, meetingLink) {
  const appt = appointments.find((item) => item.id === id);
  if (appt) { appt.status = 'confirmed'; appt.meetingLink = meetingLink || appt.meetingLink || 'https://meet.example.com/classicfin-demo'; }
  return appt;
}
function completeAppointment(id) {
  const appt = appointments.find((item) => item.id === id);
  if (appt) appt.status = 'completed';
  return appt;
}
module.exports = { bookAppointment, confirmAppointment, completeAppointment };
