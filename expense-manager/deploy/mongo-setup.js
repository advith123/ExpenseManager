// Run with: mongosh < deploy/mongo-setup.js
// Creates a dedicated database user so the app never connects as root.
use restaurant_expense_manager
db.createUser({
  user: "em_user",
  pwd: "CHANGE_ME",
  roles: [{ role: "readWrite", db: "restaurant_expense_manager" }]
})
