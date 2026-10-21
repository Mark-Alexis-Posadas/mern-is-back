import type { Request, Response } from "express";
import { AdminCustomerService, CustomerInputError, customerId, parseCustomerQuery } from "../services/adminCustomer.service";

export async function getAdminCustomers(req: Request, res: Response) {
  try {
    return res.json(await AdminCustomerService.list(parseCustomerQuery(req.query)));
  } catch (error) {
    return customerError(error, res);
  }
}

export async function getAdminCustomer(req: Request, res: Response) {
  try {
    const id = customerId(req.params.id);
    const result = await AdminCustomerService.details(id, parseCustomerQuery(req.query));
    if (!result) return res.status(404).json({ message: "Customer not found." });
    return res.json(result);
  } catch (error) {
    return customerError(error, res);
  }
}

function customerError(error: unknown, res: Response) {
  if (error instanceof CustomerInputError) return res.status(400).json({ message: error.message });
  return res.status(500).json({ message: "Unable to fetch customer information." });
}
