async function updateUserStatus() {
  const userId = document.getElementById('userId').value.trim();
  const statusEl = document.getElementById('userIdStatus');
  const clockInBtn = document.getElementById('clockIn');
  const clockOutBtn = document.getElementById('clockOut');

  // If empty, show placeholder only
  if (!userId) {
    statusEl.className = 'loading';
    statusEl.textContent = 'Enter User ID...';
    clockInBtn.disabled = clockOutBtn.disabled = true;
    return;
  }

  // Prevent re-validation if same ID
  if (statusEl.dataset.lastId === userId) {
    return; // No change, skip
  }

  statusEl.className = 'loading';
  statusEl.textContent = 'Validating...';
  statusEl.dataset.lastId = userId; // Mark as processed

  const staff = await getStaffByUserId(userId);
  if (!staff) {
    statusEl.className = 'invalid';
    statusEl.textContent = `User ${userId} not found`;
    clockInBtn.disabled = clockOutBtn.disabled = true;
    return;
  }

  if (staff.active.toLowerCase() !== 'yes') {
    statusEl.className = 'inactive';
    statusEl.textContent = `User ${userId} : ${staff.name} is Inactive`;
    clockInBtn.disabled = clockOutBtn.disabled = true;
    return;
  }

  const approved = currentOffice && staff.allowedLocations.map(l => l.toLowerCase()).includes(currentOffice.toLowerCase());
  const icon = approved 
    ? 'Approved' 
    : 'Not Approved';

  statusEl.className = approved ? 'valid' : 'invalid';
  statusEl.textContent = `User ${userId} found : ${staff.name} ${icon}`;
  clockInBtn.disabled = clockOutBtn.disabled = !approved;
}
